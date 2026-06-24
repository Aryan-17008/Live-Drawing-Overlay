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

    const eraserSizeGroup = document.getElementById('eraser-size-group');
    const eraserDivider = document.getElementById('eraser-divider');
    const eraserSizeSlider = document.getElementById('eraser-size');
    const eraserSizeValue = document.getElementById('eraser-size-value');
    const handFeedback  = document.getElementById('hand-feedback');
    const handCursor    = document.getElementById('hand-cursor');
    const pinchIndicator = document.getElementById('pinch-indicator');
    const handLoading   = document.getElementById('hand-loading');

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
        const rect = canvas.getBoundingClientRect();
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
        undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    }

    function undo() {
        if (undoStack.length === 0) return;
        const data = undoStack.pop();
        ctx.putImageData(data, 0, 0);
    }

    // ============================================================
    // DRAWING
    // ============================================================
    function startDrawing(x, y) {
        isDrawing = true;
        lastX = x;
        lastY = y;
        pushUndo();
    }

    function draw(x, y) {
        if (!isDrawing) return;

        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);

        if (isEraser) {
            // Eraser uses destination-out to remove pixels completely (transparent)
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
            ctx.lineWidth = eraserSize;
            // Add subtle shadow to make eraser visible
            ctx.shadowBlur = 10;
            ctx.shadowColor = 'rgba(255, 255, 255, 0.3)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = currentColor;
            ctx.lineWidth = currentSize;
        }

        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.stroke();

        // Reset shadow
        ctx.shadowBlur = 0;

        lastX = x;
        lastY = y;
    }

    function stopDrawing() {
        isDrawing = false;
    }

    // ============================================================
    // HAND TRACKING
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
    }

    function removeDrawingListeners() {
        canvas.removeEventListener('mousedown', onMouseDown);
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('mouseup',   stopDrawing);
        canvas.removeEventListener('mouseout',  stopDrawing);
        canvas.removeEventListener('touchstart', onTouchStart);
        canvas.removeEventListener('touchmove',  onTouchMove);
        canvas.removeEventListener('touchend',   stopDrawing);
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
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // ============================================================
    // SAVE / DOWNLOAD
    // ============================================================
    function saveDrawing() {
        const tempCanvas = document.createElement('canvas');
        const tempCtx    = tempCanvas.getContext('2d');

        tempCanvas.width  = canvas.width;
        tempCanvas.height = canvas.height;

        tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.drawImage(canvas, 0, 0);

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
        ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (!drawingInterface.classList.contains('active')) return;

        if (e.key === 'e' || e.key === 'E') {
            toggleEraser();
        } else if (e.key === 'h' || e.key === 'H') {
            toggleHandMode();
        } else if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            undo();
        } else if (e.key === 'c' || e.key === 'C') {
            clearCanvas();
        } else if (e.key === 's' || e.key === 'S') {
            saveDrawing();
        } else if (e.key === 'f' || e.key === 'F') {
            toggleFullscreen();
        }
    });

})();
