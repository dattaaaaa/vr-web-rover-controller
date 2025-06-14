const remoteStreamImg = document.getElementById('remoteStreamImg');
const connectButton = document.getElementById('connectButton');
const enterVRButton = document.getElementById('enterVRButton');
const statusDiv = document.getElementById('status');
const controllerInfoDiv = document.getElementById('controllerInfo');

// ---- NEW: Add a canvas element to your HTML or create it dynamically ----
// For simplicity, let's assume you add this to quest.html:
// <canvas id="xrCanvas" style="display: none;"></canvas> 
// Or create it dynamically if you prefer not to clutter HTML for a non-visible canvas.
let xrCanvas; // Will hold the reference to the canvas
let gl = null; // WebGL context
// ---- END NEW ----

let ws;
let xrSession = null;
let xrRefSpace = null;
let xrWebGLLayer = null; // ---- NEW ----

const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

function updateStatus(message, isError = false) {
    console.log(message);
    statusDiv.textContent = `Status: ${message}`;
    statusDiv.style.color = isError ? 'red' : 'inherit';
}

function updateControllerInfo(data) {
    controllerInfoDiv.textContent = JSON.stringify(data, null, 2);
}

connectButton.addEventListener('click', () => {
    connectButton.disabled = true;
    updateStatus('Connecting to server...');
    setupWebSocket();
});

function setupWebSocket() {
    // ... (WebSocket setup code remains the same) ...
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log("WebSocket already open or connecting.");
        return;
    }
    ws = new WebSocket(WS_URL);
    updateStatus('Attempting to connect to server...');


    ws.onopen = () => {
        updateStatus('Connected to server. Registering as Quest Viewer...');
        ws.send(JSON.stringify({ type: 'register_quest_viewer' }));
        connectButton.style.display = 'none';
        if (navigator.xr) {
            enterVRButton.style.display = 'inline-block';
            // ---- NEW: Get canvas reference here or create dynamically ----
            xrCanvas = document.getElementById('xrCanvas'); 
            if (!xrCanvas) { // Fallback: create dynamically if not in HTML
                xrCanvas = document.createElement('canvas');
                xrCanvas.id = 'xrCanvas';
                // You might want to append it to the body, though for non-rendering it might not matter
                // document.body.appendChild(xrCanvas); 
                console.log("Dynamically created XR canvas.");
            }
            // ---- END NEW ----
        } else {
            updateStatus('WebXR not supported on this browser/device.', true);
        }
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        // console.log('Quest WS received:', data.type); // Less verbose

        switch (data.type) {
            case 'ip_webcam_url_update':
                if (data.url && typeof data.url === 'string') {
                    updateStatus(`Received IP Webcam URL: ${data.url}`);
                    console.log("QUEST DEBUG: Setting img src to:", data.url);
                    remoteStreamImg.src = data.url;
                    remoteStreamImg.alt = "Streaming from " + data.url;
                    remoteStreamImg.onerror = function() {
                        console.error("QUEST DEBUG: Error loading image from src:", remoteStreamImg.src);
                        updateStatus(`Error loading stream from ${remoteStreamImg.src}. Check URL and network.`, true);
                        remoteStreamImg.alt = `Failed to load: ${remoteStreamImg.src}`;
                    };
                    remoteStreamImg.onload = function() {
                        console.log("QUEST DEBUG: Image loaded successfully from src:", remoteStreamImg.src);
                        updateStatus(`Streaming from ${remoteStreamImg.src}`);
                    };
                } else {
                    updateStatus('Received invalid or empty IP Webcam URL. Stream will not start.', true);
                    remoteStreamImg.src = "#";
                    remoteStreamImg.alt = "IP Webcam URL not set or invalid.";
                }
                break;
            case 'no_stream_url_set':
                updateStatus('No IP Webcam URL has been set on the server yet. Please use the Mobile Setup page.', true);
                remoteStreamImg.src = "#";
                remoteStreamImg.alt = "IP Webcam URL not set yet on server.";
                break;
            case 'controller_input':
                updateControllerInfo(data.input);
                break;
            case 'error':
                updateStatus(`Server error: ${data.message}`, true);
                break;
            default:
                // console.log("Unknown message from server:", data);
        }
    };

    ws.onclose = (event) => {
        updateStatus(`Disconnected from server (Code: ${event.code}). Please refresh to reconnect.`, true);
        connectButton.disabled = false;
        connectButton.style.display = 'inline-block';
        enterVRButton.style.display = 'none';
        remoteStreamImg.src = "#";
        remoteStreamImg.alt = "Disconnected. Refresh to connect.";
        ws = null;
        // If VR session was active, good idea to try and end it
        if (xrSession) {
            onXRSessionEnded(); // Call our cleanup
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('WebSocket connection error. Check server and network.', true);
    };
}


// --- WebXR Logic ---
enterVRButton.addEventListener('click', async () => {
    if (!xrSession) { // Start a new session
        if (navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')) { // Check support first
            try {
                xrSession = await navigator.xr.requestSession('immersive-vr');
                updateStatus('VR Session Requested...');

                // ---- NEW: WEBGL AND LAYER SETUP ----
                if (!xrCanvas) { // Ensure canvas exists
                    updateStatus("XR Canvas not found for WebGL context.", true);
                    await xrSession.end(); // Abort session
                    return;
                }
                gl = xrCanvas.getContext('webgl', { xrCompatible: true });
                if (!gl) {
                    updateStatus("Failed to get WebGL context for XR.", true);
                    await xrSession.end(); // Abort session
                    return;
                }
                
                // Make sure context is compatible and set up the layer
                await gl.makeXRCompatible(); // Important step!

                xrWebGLLayer = new XRWebGLLayer(xrSession, gl);
                await xrSession.updateRenderState({ baseLayer: xrWebGLLayer });
                updateStatus('VR Render State Updated with Layer.');
                // ---- END NEW ----

                xrSession.addEventListener('end', onXRSessionEnded);
                // Add other listeners as needed (visibilitychange, etc.)
                xrSession.addEventListener('visibilitychange', (event) => {
                    console.log(`XR Session visibility changed: ${event.session.visibilityState}`);
                    updateStatus(`XR visibility: ${event.session.visibilityState}`);
                });


                xrRefSpace = await xrSession.requestReferenceSpace('local');
                updateStatus('VR Reference Space Acquired.');

                // Start the render loop
                xrSession.requestAnimationFrame(onXRFrame);
                updateStatus('VR Session Started & Render Loop Active');
                enterVRButton.textContent = 'Exit VR';

            } catch (e) {
                console.error('Failed to start XR session:', e);
                updateStatus(`Failed to start XR session: ${e.name} - ${e.message}`, true);
                if (xrSession) { // Ensure session is cleaned up on error
                    try { await xrSession.end(); } catch (endErr) { console.error("Error ending session after failed start:", endErr); }
                }
                xrSession = null; // Reset session variable
            }
        } else {
            updateStatus('Immersive VR not supported or WebXR not available.', true);
        }
    } else { // End existing session
        try {
            await xrSession.end();
            // onXRSessionEnded will be called by the 'end' event
        } catch (e) {
            console.error("Error ending XR session:", e);
            onXRSessionEnded(); // Manually call if end() throws to ensure cleanup
        }
    }
});

function onXRSessionEnded() {
    updateStatus('VR Session Ended');
    if (enterVRButton) enterVRButton.textContent = 'Enter VR';
    if (controllerInfoDiv) controllerInfoDiv.textContent = 'Exited VR. Controller input paused.';
    
    xrSession = null;
    xrRefSpace = null;
    xrWebGLLayer = null; // ---- NEW: Clear layer ----
    // gl = null; // Optionally clear GL context if you recreate canvas each time
    console.log("XR Session variables cleared.");
}

function onXRFrame(time, frame) {
    if (!xrSession) {
        // console.log("onXRFrame: No session, returning.");
        return;
    }
    // IMPORTANT: Keep requesting frames
    xrSession.requestAnimationFrame(onXRFrame); 

    // ---- NEW: Minimal WebGL work to clear the layer ----
    // Even if you don't draw anything, you should at least bind the framebuffer
    // and clear it. Otherwise, you might see stale content or artifacts.
    const pose = frame.getViewerPose(xrRefSpace);
    if (pose) {
        if (gl && xrWebGLLayer) { // Check if gl and layer are available
            // For each view (eye)
            for (const view of pose.views) {
                const viewport = xrWebGLLayer.getViewport(view);
                if (!viewport) continue;

                gl.bindFramebuffer(gl.FRAMEBUFFER, xrWebGLLayer.framebuffer);
                gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
                
                // Clear the canvas for this view
                // You can set any color, e.g., black or transparent if supported
                gl.clearColor(0, 0, 0, 0); // Transparent black
                gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
                
                // If you were drawing 3D content, you'd do it here
                // using view.transform, view.projectionMatrix, etc.
            }
        }
    } else {
        // console.warn("onXRFrame: No pose available.");
    }
    // ---- END NEW ----

    // Controller input processing (remains the same)
    const inputSources = frame.session.inputSources; // Use frame.session.inputSources
    let controllerData = {
        timestamp: time,
        inputs: []
    };

    for (const source of inputSources) {
        if (source.gamepad) {
            let inputDetail = {
                handedness: source.handedness,
                buttons: [],
                axes: Array.from(source.gamepad.axes)
            };
            source.gamepad.buttons.forEach((button, index) => {
                inputDetail.buttons.push({
                    index: index,
                    pressed: button.pressed,
                    touched: button.touched,
                    value: button.value
                });
            });
            controllerData.inputs.push(inputDetail);
        }
        // You might want to remove and re-add these listeners on inputsourceschange
        // to avoid duplicate listeners if sources are re-evaluated.
        // For simplicity, keeping it here.
        // source.addEventListener('selectstart', (event) => handleControllerEvent(event, 'selectstart'));
        // source.addEventListener('selectend', (event) => handleControllerEvent(event, 'selectend'));
    }

    if (controllerData.inputs.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'controller_input', input: controllerData }));
    }
}

// Function to handle controller events like selectstart/end (if you use them)
// function handleControllerEvent(event, eventType) { ... }

// Initial checks for HTTPS (same as before)
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    // ...
}
