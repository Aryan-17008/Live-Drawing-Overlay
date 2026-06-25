(function() {
    'use strict';

    // ============================================================
    // DOM ELEMENTS
    // ============================================================
    const permissionScreen = document.getElementById('permission-screen');
    const drawingInterface  = document.getElementById('drawing-interface');
    const startBtn          = document.getElementById('start-btn');
    const permissionError   = document.getElementById('permission-error');

    const video   = document.getElementById('webcam');
    const canvas  = document.getElementById('drawing-canvas');
    const ctx     = canvas.getContext('2d', { willReadFrequently: true });

    // Expose context to multiplayer module
    window.drawingCtx = ctx;

    const colorPicker   = document.getElementById('color-picker');
    const colorPreview  = document.getElementById('color-preview');
    const brushSize     = document.getElementById('brush-size');
    const sizeValue     = document.getElementById('size-value');

    const eraserBtn     = document.getElementById('eraser-btn');
    const handModeBtn   = document.getElementById('hand-mode-btn');
    const undoBtn       = document.getElementById('undo-btn');
    const clearBtn      = document.getElementById('clear-btn');
    const saveBtn       = document.getElementById('save-btn');
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const smoothingBtn = document.getElementById('smoothing-btn');

    const eraserSizeGroup = document.getElementById('eraser-size-group');
    const eraserDivider = document.getElementById('eraser-divider');
    const eraserSizeSlider = document.getElementById('eraser-size');
    const eraserSizeValue = document.getElementById('eraser-size-value');
    const handFeedback  = document.getElementById('hand-feedback');
    const handCursor    = document.getElementById('hand-cursor');
    const pinchIndicator = document.getElementById('pinch-indicator');
    const handLoading   = document.getElementById('hand-loading');

    // Plain canvas mode elements
    const videoContainer = document.getElementById('video-container');
    const plainCanvasContainer = document.getElementById('plain-canvas-container');
    const plainCanvas = document.getElementById('plain-canvas');
    const plainCtx = plainCanvas ? plainCanvas.getContext('2d', { willReadFrequently: true }) : null;
    const plainCanvasBtn = document.getElementById('plain-canvas-btn');
    const bgColorPicker = document.getElementById('bg-color-picker');
    const bgColorPreview = document.getElementById('bg-color-preview');
    const bgColorGroup = document.getElementById('bg-color-group');
    const bgColorDivider = document.getElementById('bg-color-divider');

    // ============================================================
    // STATE
    // ============================================================
    let isDrawing    = false;
    let lastX        = 0;
    let lastY        = 0;
    let currentColor = '#00ff88';
    let currentSize  = 5;
    let isEraser     = false;
    let undoStack    = [];
    const MAX_UNDO   = 20;

    // Eraser size (separate from brush size)
    let eraserSize   = 20;

    // Hand tracking state
    let handModeActive = false;
    let hands          = null;
    let handRafId      = null;

    // Plain canvas mode state
    let isPlainCanvasMode = false;
    let plainCanvasBgColor = '#ffffff';
    let activeCtx = ctx; // Current drawing context (ctx or plainCtx)
    let activeCanvas = canvas; // Current canvas element
    let handX          = 0;
    let handY          = 0;
    let isPinching     = false;
    let wasPinching    = false;
    const PINCH_THRESHOLD = 0.08;

    // Gesture mode
    let lastControlGesture = null;
    let controlGestureCooldown = 0;
    const GESTURE_COOLDOWN_MS = 1500;

    // Smoothing
    let smoothedX = 0;
    let smoothedY = 0;
    const SMOOTHING_FACTOR = 0.3;

    // ============================================================
    // CANVAS SIZING
    // ============================================================
    function resizeCanvas() {
        const container = canvas.parentElement;
        const w = Math.round(container.clientWidth);
        const h = Math.round(container.clientHeight);
        if (w === 0 || h === 0) return;
        canvas.width  = w;
        canvas.height = h;
        console.log('Canvas resized to:', w, 'x', h);
    }

    // ============================================================
    // COORDINATE MAPPING
    // ============================================================
    function getCoords(e) {
        const rect = activeCanvas.getBoundingClientRect();
        const clientX = e.clientX ?? (e.touches && e.touches[0].clientX);
        const clientY = e.clientY ?? (e.touches && e.touches[0].clientY);
        return {
            x: clientX - rect.left,
            y: clientY - rect.top
        };
    }

    // ============================================================
    // UNDO STACK
    // ============================================================
    function pushUndo() {
        if (undoStack.length >= MAX_UNDO) undoStack.shift();
        undoStack.push(activeCtx.getImageData(0, 0, activeCanvas.width, activeCanvas.height));
    }

    function undo() {
        if (undoStack.length === 0) return;
        const data = undoStack.pop();
        activeCtx.putImageData(data, 0, 0);
    }

    // ============================================================
    // DRAWING
    // ============================================================
    // ============================================================
    // DRAWING WITH SMOOTHING
    // ============================================================
    let drawPoints = []; // Store points for smoothing
    let smoothingEnabled = true;

    function startDrawing(x, y) {
        isDrawing = true;
        lastX = x;
        lastY = y;
        drawPoints = [{x, y}]; // Reset points
        pushUndo();
    }

    function draw(x, y) {
        if (!isDrawing) return;
        
        // Use active context (video canvas or plain canvas)
        const ctx = activeCtx;

        if (!smoothingEnabled) {
            // Simple line drawing without smoothing
            ctx.beginPath();
            ctx.moveTo(lastX, lastY);
            ctx.lineTo(x, y);

            if (isEraser) {
                ctx.globalCompositeOperation = 'destination-out';
                ctx.lineWidth = eraserSize;
                ctx.shadowBlur = 10;
                ctx.shadowColor = 'rgba(255, 255, 255, 0.3)';
            } else {
                ctx.globalCompositeOperation = 'source-over';
                ctx.strokeStyle = currentColor;
                ctx.lineWidth = currentSize;
            }

            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();
            ctx.shadowBlur = 0;

            // Broadcast to peers
            if (window.multiplayer && window.multiplayer.isConnected()) {
                window.multiplayer.broadcast({
                    type: 'stroke',
                    fromX: lastX,
                    fromY: lastY,
                    toX: x,
                    toY: y,
                    color: currentColor,
                    size: currentSize,
                    isEraser: isEraser,
                    eraserSize: eraserSize
                });
            }

            lastX = x;
            lastY = y;
            return;
        }

        // Add point to history for smoothing
        drawPoints.push({x, y});

        // Need at least 2 points to draw
        if (drawPoints.length < 2) return;

        ctx.beginPath();

        if (drawPoints.length === 2) {
            // First segment: just draw a line
            ctx.moveTo(drawPoints[0].x, drawPoints[0].y);
            ctx.lineTo(drawPoints[1].x, drawPoints[1].y);
        } else {
            // Use quadratic curves for smoothing
            // Move to the first point
            ctx.moveTo(drawPoints[0].x, drawPoints[0].y);

            // Draw quadratic curves through midpoints
            for (let i = 1; i < drawPoints.length - 1; i++) {
                const p0 = drawPoints[i - 1];
                const p1 = drawPoints[i];
                const p2 = drawPoints[i + 1];

                // Calculate midpoint between p0 and p1
                const midX = (p0.x + p1.x) / 2;
                const midY = (p0.y + p1.y) / 2;

                // Draw quadratic curve to midpoint of p1 and p2
                const endX = (p1.x + p2.x) / 2;
                const endY = (p1.y + p2.y) / 2;

                ctx.quadraticCurveTo(p1.x, p1.y, endX, endY);
            }

            // Draw final segment to last point
            const last = drawPoints[drawPoints.length - 1];
            const secondLast = drawPoints[drawPoints.length - 2];
            const midX = (secondLast.x + last.x) / 2;
            const midY = (secondLast.y + last.y) / 2;
            ctx.lineTo(last.x, last.y);
        }

        if (isEraser) {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.lineWidth = eraserSize;
            ctx.shadowBlur = 10;
            ctx.shadowColor = 'rgba(255, 255, 255, 0.3)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = currentColor;
            ctx.lineWidth = currentSize;
        }

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Reset shadow
        ctx.shadowBlur = 0;

        // Broadcast to peers
        if (window.multiplayer && window.multiplayer.isConnected()) {
            window.multiplayer.broadcast({
                type: 'stroke',
                fromX: lastX,
                fromY: lastY,
                toX: x,
                toY: y,
                color: currentColor,
                size: currentSize,
                isEraser: isEraser,
                eraserSize: eraserSize
            });
        }

        // Keep last points for continuity but limit history
        if (drawPoints.length > 3) {
            drawPoints = drawPoints.slice(-2);
        }

        lastX = x;
        lastY = y;
    }

    function stopDrawing() {
        isDrawing = false;
        drawPoints = [];
    }

    // ============================================================
    // SMOOTHING TOGGLE
    // ============================================================
    function toggleSmoothing() {
        smoothingEnabled = !smoothingEnabled;
        if (smoothingBtn) smoothingBtn.classList.toggle('active', smoothingEnabled);
    }
    // ============================================================
    function initHandTracking() {
        if (hands) return Promise.resolve();

        return new Promise((resolve, reject) => {
            try {
                hands = new Hands({
                    locateFile: (file) => {
                        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
                    }
                });

                hands.setOptions({
                    maxNumHands: 2,
                    modelComplexity: 1,
                    minDetectionConfidence: 0.3,
                    minTrackingConfidence: 0.3
                });

                hands.onResults(onHandResults);
                console.log('MediaPipe Hands initialized');
                resolve();
            } catch (err) {
                console.error('MediaPipe init error:', err);
                reject(err);
            }
        });
    }

    let handDetected = false;

    // ============================================================
    // GESTURE DETECTION HELPERS
    // ============================================================
    // Gesture smoothing
    let gestureHistory = [];
    const GESTURE_HISTORY_SIZE = 3;
    let stableGesture = 'open';

    function detectGesture(landmarks) {
        const wrist = landmarks[0];
        const thumbTip = landmarks[4];
        const indexTip = landmarks[8];
        const middleTip = landmarks[12];
        const ringTip = landmarks[16];
        const pinkyTip = landmarks[20];
        const indexMCP = landmarks[5];
        const middleMCP = landmarks[9];
        const ringMCP = landmarks[13];
        const pinkyMCP = landmarks[17];

        // Calculate distances from wrist to fingertips
        const dIndex = Math.hypot(indexTip.x - wrist.x, indexTip.y - wrist.y);
        const dMiddle = Math.hypot(middleTip.x - wrist.x, middleTip.y - wrist.y);
        const dRing = Math.hypot(ringTip.x - wrist.x, ringTip.y - wrist.y);
        const dPinky = Math.hypot(pinkyTip.x - wrist.x, pinkyTip.y - wrist.y);

        // Reference: distance from wrist to middle MCP (palm size)
        const palmSize = Math.hypot(middleMCP.x - wrist.x, middleMCP.y - wrist.y);

        const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);

        // Count extended fingers (tip further from wrist than MCP)
        let extendedCount = 0;
        if (dIndex > palmSize * 0.9) extendedCount++;
        if (dMiddle > palmSize * 0.9) extendedCount++;
        if (dRing > palmSize * 0.9) extendedCount++;
        if (dPinky > palmSize * 0.9) extendedCount++;

        // Classify gesture
        let gesture;
        if (extendedCount === 2 && dIndex > palmSize * 0.9 && dMiddle > palmSize * 0.9 && dRing < palmSize * 0.9 && dPinky < palmSize * 0.9) {
            // Exactly index + middle extended, ring + pinky curled = two finger eraser
            gesture = 'twofinger';
        } else if (extendedCount >= 3 && pinchDist > 0.1) {
            // Most fingers extended and thumb not touching = open/spread
            gesture = 'spread';
        } else if (pinchDist < 0.1) {
            // Thumb and index close = pinch (regardless of other fingers for eraser mode)
            gesture = 'pinch';
        } else {
            gesture = 'open';
        }

        // Smoothing: require GESTURE_HISTORY_SIZE consecutive same gestures
        gestureHistory.push(gesture);
        if (gestureHistory.length > GESTURE_HISTORY_SIZE) {
            gestureHistory.shift();
        }

        // Only change stable gesture if all recent frames agree
        const allSame = gestureHistory.every(g => g === gesture);
        if (allSame && gestureHistory.length >= GESTURE_HISTORY_SIZE) {
            stableGesture = gesture;
        }

        return stableGesture;
    }

    function showGestureFeedback(text) {
        const feedback = document.getElementById('gesture-feedback');
        const gestureText = document.getElementById('gesture-text');
        gestureText.textContent = text;
        feedback.classList.remove('hidden');
        setTimeout(() => feedback.classList.add('hidden'), 1200);
    }

    // ============================================================
    // ONE-HAND MODE: pinch=draw, open=undo, fist=eraser
    // ============================================================
    function onHandResults(results) {
        if (!handModeActive) return;

        const now = Date.now();

        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            // Use first detected hand
            const landmarks = results.multiHandLandmarks[0];
            const gesture = detectGesture(landmarks);
            const indexTip = landmarks[8];
            const thumbTip = landmarks[4];
            const mirroredX = 1 - indexTip.x;
            const rawX = mirroredX * canvas.width;
            const rawY = indexTip.y * canvas.height;

            // Smooth cursor
            if (smoothedX === 0 && smoothedY === 0) {
                smoothedX = rawX;
                smoothedY = rawY;
            } else {
                smoothedX = smoothedX + (rawX - smoothedX) * SMOOTHING_FACTOR;
                smoothedY = smoothedY + (rawY - smoothedY) * SMOOTHING_FACTOR;
            }

            // Update cursor position
            const canvasRect = canvas.getBoundingClientRect();
            updateHandCursor(canvasRect.left + (mirroredX * canvasRect.width), canvasRect.top + (indexTip.y * canvasRect.height));

            // Handle gestures
            if (gesture === 'pinch') {
                // Pinch = draw
                if (!isDrawing) {
                    startDrawing(smoothedX, smoothedY);
                } else {
                    draw(smoothedX, smoothedY);
                }
                pinchIndicator.classList.add('active');
                handCursor.style.borderColor = '#ff4757';
            } else {
                // Not pinching = stop drawing
                if (isDrawing) {
                    stopDrawing();
                }
                pinchIndicator.classList.remove('active');

                // Gesture actions
                // Open palm = undo (transition from anything to spread)
                if (gesture === 'spread' && lastControlGesture !== 'spread') {
                    if (now > controlGestureCooldown) {
                        undo();
                        showGestureFeedback('Undo');
                        controlGestureCooldown = now + GESTURE_COOLDOWN_MS;
                    }
                }
                // Two fingers = toggle eraser (transition from anything to twofinger)
                else if (gesture === 'twofinger' && lastControlGesture !== 'twofinger') {
                    if (now > controlGestureCooldown) {
                        toggleEraser();
                        showGestureFeedback(isEraser ? 'Eraser On' : 'Eraser Off');
                        controlGestureCooldown = now + GESTURE_COOLDOWN_MS;
                    }
                }

                // Cursor color by gesture
                if (gesture === 'spread') handCursor.style.borderColor = '#2bf0ff';
                else if (gesture === 'twofinger') handCursor.style.borderColor = '#ff4757';
                else handCursor.style.borderColor = '#00ff88';
            }

            lastControlGesture = gesture;
            handDetected = true;
        } else {
            handCursor.classList.remove('visible');
            pinchIndicator.classList.remove('active');
            if (isDrawing) stopDrawing();
            wasPinching = false;
            isPinching = false;
            handDetected = false;
            lastControlGesture = null;
        }
    }

    function updateHandCursor(screenX, screenY) {
        handCursor.style.left = screenX + 'px';
        handCursor.style.top = screenY + 'px';
        handCursor.classList.add('visible');

        if (isPinching) {
            pinchIndicator.classList.add('active');
            pinchIndicator.style.left = screenX + 'px';
            pinchIndicator.style.top = screenY + 'px';
            handCursor.style.borderColor = '#ff4757';
        } else {
            pinchIndicator.classList.remove('active');
            handCursor.style.borderColor = '#00ff88';
        }
    }

    async function toggleHandMode() {
        handModeActive = !handModeActive;
        handModeBtn.classList.toggle('active', handModeActive);

        if (handModeActive) {
            handLoading.classList.remove('hidden');

            try {
                await initHandTracking();

                let frameCount = 0;
                async function processFrame() {
                    if (!handModeActive) return;
                    if (video.readyState >= 2) {
                        try {
                            await hands.send({ image: video });
                            frameCount++;
                            if (frameCount === 1) {
                                console.log('First frame processed');
                                handLoading.classList.add('hidden');
                            }
                        } catch (err) {
                            console.error('hands.send error:', err);
                        }
                    }
                    handRafId = requestAnimationFrame(processFrame);
                }
                handRafId = requestAnimationFrame(processFrame);

                setTimeout(() => {
                    if (frameCount === 0) {
                        console.warn('Hand tracking timeout');
                        handLoading.classList.add('hidden');
                    }
                }, 10000);

                handFeedback.classList.remove('hidden');
                handLoading.classList.add('hidden');
                removeDrawingListeners();
            } catch (err) {
                console.error('Hand tracking error:', err);
                handLoading.classList.add('hidden');
                handModeActive = false;
                handModeBtn.classList.remove('active');
                alert('Failed to initialize hand tracking.');
            }
        } else {
            handFeedback.classList.add('hidden');
            handCursor.classList.remove('visible');
            pinchIndicator.classList.remove('active');
            stopDrawing();

            if (handRafId) {
                cancelAnimationFrame(handRafId);
                handRafId = null;
            }

            addDrawingListeners();
        }
    }

    // ============================================================
    // DRAWING LISTENERS (Mouse + Touch)
    // ============================================================
    function addDrawingListeners() {
        canvas.addEventListener('mousedown', onMouseDown);
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mouseup',   stopDrawing);
        canvas.addEventListener('mouseout',    stopDrawing);
        canvas.addEventListener('touchstart',  onTouchStart, { passive: false });
        canvas.addEventListener('touchmove',   onTouchMove,  { passive: false });
        canvas.addEventListener('touchend',    stopDrawing);
        
        // Add listeners to plain canvas too
        if (plainCanvas) {
            plainCanvas.addEventListener('mousedown', onMouseDown);
            plainCanvas.addEventListener('mousemove', onMouseMove);
            plainCanvas.addEventListener('mouseup',   stopDrawing);
            plainCanvas.addEventListener('mouseout',    stopDrawing);
            plainCanvas.addEventListener('touchstart',  onTouchStart, { passive: false });
            plainCanvas.addEventListener('touchmove',   onTouchMove,  { passive: false });
            plainCanvas.addEventListener('touchend',    stopDrawing);
        }
    }

    function removeDrawingListeners() {
        canvas.removeEventListener('mousedown', onMouseDown);
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('mouseup',   stopDrawing);
        canvas.removeEventListener('mouseout',  stopDrawing);
        canvas.removeEventListener('touchstart', onTouchStart);
        canvas.removeEventListener('touchmove',  onTouchMove);
        canvas.removeEventListener('touchend',   stopDrawing);
        
        // Remove listeners from plain canvas too
        if (plainCanvas) {
            plainCanvas.removeEventListener('mousedown', onMouseDown);
            plainCanvas.removeEventListener('mousemove', onMouseMove);
            plainCanvas.removeEventListener('mouseup',   stopDrawing);
            plainCanvas.removeEventListener('mouseout',    stopDrawing);
            plainCanvas.removeEventListener('touchstart', onTouchStart);
            plainCanvas.removeEventListener('touchmove',  onTouchMove);
            plainCanvas.removeEventListener('touchend',   stopDrawing);
        }
    }

    function onMouseDown(e) {
        const c = getCoords(e);
        startDrawing(c.x, c.y);
    }

    function onMouseMove(e) {
        const c = getCoords(e);
        draw(c.x, c.y);
    }

    function onTouchStart(e) {
        e.preventDefault();
        const c = getCoords(e);
        startDrawing(c.x, c.y);
    }

    function onTouchMove(e) {
        e.preventDefault();
        const c = getCoords(e);
        draw(c.x, c.y);
    }

    // ============================================================
    // CAMERA INITIALIZATION
    // ============================================================
    async function startCamera() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width:  { ideal: 1920 },
                    height: { ideal: 1080 },
                    facingMode: 'user'
                },
                audio: false
            });

            video.srcObject = stream;

            video.onloadedmetadata = () => {
                video.play();
                resizeCanvas();
                permissionScreen.classList.remove('active');
                drawingInterface.classList.add('active');
            };

        } catch (err) {
            console.error('Camera error:', err);
            let message = 'Could not access the camera.';

            if (err.name === 'NotAllowedError') {
                message = 'Camera permission was denied. Please allow camera access in your browser settings and refresh.';
            } else if (err.name === 'NotFoundError') {
                message = 'No camera found. Please connect a camera and try again.';
            } else if (err.name === 'NotReadableError') {
                message = 'Camera is already in use by another application.';
            }

            permissionError.textContent = message;
            permissionError.classList.remove('hidden');
        }
    }

    // ============================================================
    // TOOL ACTIONS
    // ============================================================
    function toggleEraser() {
        isEraser = !isEraser;
        eraserBtn.classList.toggle('active', isEraser);
        if (eraserSizeGroup) eraserSizeGroup.style.display = isEraser ? 'flex' : 'none';
        if (eraserDivider) eraserDivider.style.display = isEraser ? 'block' : 'none';
    }

    function clearCanvas() {
        pushUndo();
        if (isPlainCanvasMode && plainCtx) {
            plainCtx.fillStyle = plainCanvasBgColor;
            plainCtx.fillRect(0, 0, plainCanvas.width, plainCanvas.height);
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    // ============================================================
    // PLAIN CANVAS MODE
    // ============================================================
    function togglePlainCanvasMode() {
        isPlainCanvasMode = !isPlainCanvasMode;
        plainCanvasBtn.classList.toggle('active', isPlainCanvasMode);
        
        if (isPlainCanvasMode) {
            // Switch to plain canvas
            videoContainer.classList.add('hidden');
            plainCanvasContainer.classList.remove('hidden');
            bgColorGroup.style.display = 'flex';
            bgColorDivider.style.display = 'block';
            
            // Set up plain canvas
            resizePlainCanvas();
            plainCtx.fillStyle = plainCanvasBgColor;
            plainCtx.fillRect(0, 0, plainCanvas.width, plainCanvas.height);
            
            // Update active context
            activeCtx = plainCtx;
            activeCanvas = plainCanvas;
            window.drawingCtx = plainCtx;
            
            // Copy existing drawing if any
            if (ctx && canvas.width > 0 && canvas.height > 0) {
                plainCtx.drawImage(canvas, 0, 0);
            }
        } else {
            // Switch back to video mode
            plainCanvasContainer.classList.add('hidden');
            videoContainer.classList.remove('hidden');
            bgColorGroup.style.display = 'none';
            bgColorDivider.style.display = 'none';
            
            // Update active context
            activeCtx = ctx;
            activeCanvas = canvas;
            window.drawingCtx = ctx;
        }
        
        console.log('Plain canvas mode:', isPlainCanvasMode);
    }

    function resizePlainCanvas() {
        if (!plainCanvas) return;
        const container = plainCanvasContainer;
        const w = Math.round(container.clientWidth);
        const h = Math.round(container.clientHeight);
        if (w === 0 || h === 0) return;
        plainCanvas.width = w;
        plainCanvas.height = h;
        console.log('Plain canvas resized to:', w, 'x', h);
    }

    function updatePlainCanvasBgColor(color) {
        plainCanvasBgColor = color;
        if (bgColorPreview) bgColorPreview.style.backgroundColor = color;
        if (isPlainCanvasMode && plainCtx) {
            // Save current content
            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');
            tempCanvas.width = plainCanvas.width;
            tempCanvas.height = plainCanvas.height;
            tempCtx.drawImage(plainCanvas, 0, 0);
            
            // Fill with new background
            plainCtx.fillStyle = color;
            plainCtx.fillRect(0, 0, plainCanvas.width, plainCanvas.height);
            
            // Restore content (this will blend, but it's the best we can do)
            plainCtx.drawImage(tempCanvas, 0, 0);
        }
    }

    // ============================================================
    // SAVE / DOWNLOAD
    // ============================================================
    function saveDrawing() {
        const tempCanvas = document.createElement('canvas');
        const tempCtx    = tempCanvas.getContext('2d');

        if (isPlainCanvasMode && plainCanvas) {
            // Save plain canvas directly
            tempCanvas.width  = plainCanvas.width;
            tempCanvas.height = plainCanvas.height;
            tempCtx.drawImage(plainCanvas, 0, 0);
        } else {
            // Save video + drawing overlay
            tempCanvas.width  = canvas.width;
            tempCanvas.height = canvas.height;
            tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
            tempCtx.drawImage(canvas, 0, 0);
        }

        const link = document.createElement('a');
        link.download = 'live-drawing-' +
            new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.png';
        link.href = tempCanvas.toDataURL('image/png');
        link.click();
    }

    // ============================================================
    // FULLSCREEN
    // ============================================================
    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen();
        }
    }

    // ============================================================
    // EVENT LISTENERS
    // ============================================================
    startBtn.addEventListener('click', startCamera);

    // Initial drawing listeners
    addDrawingListeners();

    // Color picker
    colorPicker.addEventListener('input', (e) => {
        currentColor = e.target.value;
        colorPreview.style.background = currentColor;
        if (isEraser) toggleEraser();
    });

    // Brush size
    brushSize.addEventListener('input', (e) => {
        currentSize = parseInt(e.target.value, 10);
        sizeValue.textContent = currentSize;
    });

    // Eraser size
    if (eraserSizeSlider) {
        eraserSizeSlider.addEventListener('input', (e) => {
            eraserSize = parseInt(e.target.value, 10);
            if (eraserSizeValue) eraserSizeValue.textContent = eraserSize;
        });
    }

    // Toolbar buttons
    eraserBtn.addEventListener('click', toggleEraser);
    handModeBtn.addEventListener('click', toggleHandMode);
    undoBtn.addEventListener('click', undo);
    clearBtn.addEventListener('click', clearCanvas);
    saveBtn.addEventListener('click', saveDrawing);
    fullscreenBtn.addEventListener('click', toggleFullscreen);
    if (smoothingBtn) smoothingBtn.addEventListener('click', toggleSmoothing);
    
    // Plain canvas mode toggle
    if (plainCanvasBtn) {
        plainCanvasBtn.addEventListener('click', togglePlainCanvasMode);
    }
    
    // Background color picker
    if (bgColorPicker) {
        bgColorPicker.addEventListener('input', (e) => {
            updatePlainCanvasBgColor(e.target.value);
        });
    }

    // Responsive resize
    window.addEventListener('resize', () => {
        if (!drawingInterface.classList.contains('active')) return;
        if (canvas.width === 0 || canvas.height === 0) return;

        const tempCanvas = document.createElement('canvas');
        const tempCtx    = tempCanvas.getContext('2d');
        tempCanvas.width  = canvas.width;
        tempCanvas.height = canvas.height;
        tempCtx.drawImage(canvas, 0, 0);

        resizeCanvas();
        if (canvas.width === 0 || canvas.height === 0) return;
        // Draw saved content (which includes black background)
        ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (!drawingInterface.classList.contains('active')) return;

        if (e.key === 'e' || e.key === 'E') {
            toggleEraser();
        } else if (e.key === 'h' || e.key === 'H') {
            toggleHandMode();
        } else if (e.key === 'm' || e.key === 'M') {
            toggleSmoothing();
        } else if (e.key === 'p' || e.key === 'P') {
            if (multiplayerPanel) multiplayerPanel.classList.toggle('hidden');
        } else if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            undo();
        } else if (e.key === 'c' || e.key === 'C') {
            clearCanvas();
        } else if (e.key === 's' || e.key === 'S') {
            saveDrawing();
        } else if (e.key === 'f' || e.key === 'F') {
            toggleFullscreen();
        } else if (e.key === 'v' || e.key === 'V') {
            togglePlainCanvasMode();
        }
    });

})();
