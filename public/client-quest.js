// --- START OF FILE public/client-quest.js ---

const remoteStreamImg = document.getElementById('remoteStreamImg');
const connectButton = document.getElementById('connectButton');
const enterVRButton = document.getElementById('enterVRButton');
const statusDiv = document.getElementById('status');
const controllerInfoDiv = document.getElementById('controllerInfo');

let xrCanvas;
let gl = null;

let shaderProgram = null;
let videoTexture = null;
let quadBuffer = null;
let positionAttribLocation = null;
let texCoordAttribLocation = null;
let projectionUniformLocation = null;
let modelViewUniformLocation = null;
let textureUniformLocation = null;

let ws;
let xrSession = null;
let xrRefSpace = null;
let xrWebGLLayer = null;

const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

let lastRightThumbstickState = { pressed: false, x: 0, y: 0, sent: false };


function updateStatus(message, isError = false) {
    if (statusDiv) {
        console.log(message);
        statusDiv.textContent = `Status: ${message}`;
        statusDiv.style.color = isError ? 'red' : 'inherit';
    } else {
        console.warn("statusDiv not found for message:", message);
    }
}

function updateControllerInfo(data) {
    if (controllerInfoDiv) {
        controllerInfoDiv.textContent = JSON.stringify(data, null, 2);
    } else {
        console.warn("controllerInfoDiv not found for data:", data);
    }
}

connectButton.addEventListener('click', () => {
    connectButton.disabled = true;
    updateStatus('Connecting to server...');
    setupWebSocket();
});

function setupWebSocket() {
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
            xrCanvas = document.getElementById('xrCanvas');
            if (!xrCanvas) {
                xrCanvas = document.createElement('canvas');
                xrCanvas.id = 'xrCanvas';
                console.warn("Dynamically created XR canvas. Ensure it's in quest.html and styled if needed (though hidden).");
                 // It's generally hidden, but good to ensure it exists.
                xrCanvas.style.display = 'none'; 
                document.body.appendChild(xrCanvas);
            }
        } else {
            updateStatus('WebXR not supported on this browser/device.', true);
        }
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
            case 'ip_webcam_url_update':
                if (data.url && typeof data.url === 'string') {
                    const originalUrl = data.url; 
                    const streamSrc = data.useProxy ? '/proxied-stream' : originalUrl;

                    updateStatus(`IP Webcam URL received. Using: ${streamSrc === '/proxied-stream' ? 'proxied stream' : 'direct URL'}. Original: ${originalUrl}`);
                    console.log("QUEST: Setting img src to:", streamSrc, " (Original:", originalUrl, ")");
                    
                    remoteStreamImg.src = ''; 
                    remoteStreamImg.src = streamSrc; 
                    
                    remoteStreamImg.alt = "Streaming from " + (streamSrc === '/proxied-stream' ? `proxy (origin: ${originalUrl})` : originalUrl);

                    remoteStreamImg.onerror = function() {
                        console.error("QUEST: Error loading image from src:", remoteStreamImg.src);
                        updateStatus(`Error loading stream from ${remoteStreamImg.src}. Original: ${originalUrl}. Check server logs, IP Cam, and network.`, true);
                        remoteStreamImg.alt = `Failed to load: ${remoteStreamImg.src}`;
                    };
                    remoteStreamImg.onload = function() {
                        console.log("QUEST: Image loaded successfully from src:", remoteStreamImg.src);
                        updateStatus(`Streaming from ${remoteStreamImg.src}`);
                        if (xrSession && videoTexture && gl) {
                            updateVideoTexture();
                        }
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
            // case 'controller_input': // This was for echoing general controller data for display.
            //     updateControllerInfo(data.input); // If server echoes, it would appear here.
            //     break;
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
        if (xrSession) { 
            onXRSessionEnded();
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('WebSocket connection error. Check server and network.', true);
    };
}

// --- WebGL Shader and Resource Management (Assumed to be mostly the same as provided) ---
// ... (createShader, createShaderProgram, initWebGLResources, updateVideoTexture, drawScene)
// Ensure initWebGLResources uses appropriate quad size/position, e.g.:
// const positions = [ -2.0, -1.5, -5.0, ... ]; // For a decent view
function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Error compiling shader:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createShaderProgram(gl) {
    const vertexShaderSource = `
        attribute vec4 aVertexPosition;
        attribute vec2 aTextureCoord;
        uniform mat4 uModelViewMatrix;
        uniform mat4 uProjectionMatrix;
        varying vec2 vTextureCoord;
        void main() {
            gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
            vTextureCoord = aTextureCoord;
        }
    `;
    const fragmentShaderSource = `
        precision mediump float;
        varying vec2 vTextureCoord;
        uniform sampler2D uSampler;
        void main() {
            gl_FragColor = texture2D(uSampler, vTextureCoord);
        }
    `;
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vertexShader || !fragmentShader) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Error linking shader program:', gl.getProgramInfoLog(program));
        return null;
    }
    return program;
}

function initWebGLResources() {
    if (!gl) {
        console.error("initWebGLResources: WebGL context not available.");
        return false;
    }

    shaderProgram = createShaderProgram(gl);
    if (!shaderProgram) {
        updateStatus('Failed to create shader program', true);
        return false;
    }

    positionAttribLocation = gl.getAttribLocation(shaderProgram, 'aVertexPosition');
    texCoordAttribLocation = gl.getAttribLocation(shaderProgram, 'aTextureCoord');
    projectionUniformLocation = gl.getUniformLocation(shaderProgram, 'uProjectionMatrix');
    modelViewUniformLocation = gl.getUniformLocation(shaderProgram, 'uModelViewMatrix');
    textureUniformLocation = gl.getUniformLocation(shaderProgram, 'uSampler');

    const positions = [
        -2.0, -1.5, -4.0,  // Bottom left (width 4, height 3, at Z -4)
         2.0, -1.5, -4.0,  // Bottom right
         2.0,  1.5, -4.0,  // Top right
        -2.0,  1.5, -4.0   // Top left
    ];
    const textureCoords = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]; 
    const indices = [0, 1, 2, 0, 2, 3];

    quadBuffer = {
        position: gl.createBuffer(),
        textureCoord: gl.createBuffer(),
        indices: gl.createBuffer()
    };

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer.position);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer.textureCoord);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(textureCoords), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadBuffer.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    videoTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 255, 255])); // Placeholder

    return true;
}

function updateVideoTexture() {
    if (!gl || !videoTexture || !remoteStreamImg.complete || !remoteStreamImg.naturalWidth || remoteStreamImg.naturalWidth === 0) {
        return;
    }
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // IP Webcam streams might be upside down
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, remoteStreamImg);
}

function drawScene(projectionMatrix, modelViewMatrix) {
    if (!gl || !shaderProgram || !quadBuffer || !videoTexture) {
        // console.warn("drawScene: Missing WebGL resources."); // Can be spammy
        return;
    }
    updateVideoTexture(); 

    gl.useProgram(shaderProgram);
    gl.uniformMatrix4fv(projectionUniformLocation, false, projectionMatrix);
    gl.uniformMatrix4fv(modelViewUniformLocation, false, modelViewMatrix);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer.position);
    gl.vertexAttribPointer(positionAttribLocation, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(positionAttribLocation);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer.textureCoord);
    gl.vertexAttribPointer(texCoordAttribLocation, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(texCoordAttribLocation);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.uniform1i(textureUniformLocation, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadBuffer.indices);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

    gl.disableVertexAttribArray(positionAttribLocation);
    gl.disableVertexAttribArray(texCoordAttribLocation);
}


// --- WebXR Session Management ---
enterVRButton.addEventListener('click', async () => {
    if (!xrSession) { 
        if (navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')) {
            try {
                // Request 'local' or 'local-floor' reference space for controllers
                xrSession = await navigator.xr.requestSession('immersive-vr', { 
                    optionalFeatures: ['local-floor', 'bounded-floor'],
                    // requiredFeatures: ['local'] // Using optional for wider compatibility
                });
                updateStatus('VR Session Requested...');

                if (!xrCanvas) {
                    updateStatus("XR Canvas not found. Cannot initialize WebGL for XR.", true);
                    await xrSession.end(); xrSession = null; return;
                }
                gl = xrCanvas.getContext('webgl', { xrCompatible: true });
                if (!gl) {
                    updateStatus("Failed to get WebGL context for XR.", true);
                    await xrSession.end(); xrSession = null; return;
                }
                await gl.makeXRCompatible();

                if (!initWebGLResources()) { 
                    updateStatus("Failed to initialize WebGL resources for XR.", true);
                    await xrSession.end(); xrSession = null; return;
                }

                xrWebGLLayer = new XRWebGLLayer(xrSession, gl);
                await xrSession.updateRenderState({ baseLayer: xrWebGLLayer });
                updateStatus('VR Render State Updated with Layer.');

                xrSession.addEventListener('end', onXRSessionEnded);
                xrSession.addEventListener('visibilitychange', (event) => {
                    console.log(`XR Session visibility changed: ${event.session.visibilityState}`);
                    updateStatus(`XR visibility: ${event.session.visibilityState}`);
                });

                // Try for 'local-floor' first, fallback to 'local' or 'viewer'
                try {
                    xrRefSpace = await xrSession.requestReferenceSpace('local-floor');
                } catch (e) {
                    console.warn("Could not get 'local-floor' reference space, trying 'local'.", e);
                    try {
                        xrRefSpace = await xrSession.requestReferenceSpace('local');
                    } catch (e2) {
                        console.warn("Could not get 'local' reference space, trying 'viewer'.", e2);
                        xrRefSpace = await xrSession.requestReferenceSpace('viewer');
                    }
                }
                updateStatus('VR Reference Space Acquired.');

                // Reset last thumbstick state upon entering VR
                lastRightThumbstickState = { pressed: false, x: 0, y: 0, sent: false };

                xrSession.requestAnimationFrame(onXRFrame);
                updateStatus('VR Session Started & Render Loop Active');
                enterVRButton.textContent = 'Exit VR';

            } catch (e) {
                console.error('Failed to start XR session:', e);
                updateStatus(`Failed to start XR session: ${e.name} - ${e.message}`, true);
                if (xrSession) { 
                    try { await xrSession.end(); } catch (endErr) { console.error("Error ending session after failed start:", endErr); }
                }
                xrSession = null; 
            }
        } else {
            updateStatus('Immersive VR not supported or WebXR not available.', true);
        }
    } else { 
        try {
            // Before ending, send one last "stop" command for the rover
            if (ws && ws.readyState === WebSocket.OPEN) {
                 ws.send(JSON.stringify({ type: 'rover_stick_input', input: { pressed: false, x: 0, y: 0 } }));
                 console.log("Sent final STOP command to rover before exiting VR.");
            }
            await xrSession.end();
        } catch (e) {
            console.error("Error ending XR session:", e);
            onXRSessionEnded(); 
        }
    }
});

function onXRSessionEnded() {
    updateStatus('VR Session Ended');
    if (enterVRButton) enterVRButton.textContent = 'Enter VR';
    if (controllerInfoDiv) controllerInfoDiv.textContent = 'Exited VR. Controller input paused.';
    
    xrSession = null;
    xrRefSpace = null;
    xrWebGLLayer = null;
    
    if (gl) { 
        if (shaderProgram) { gl.deleteProgram(shaderProgram); shaderProgram = null; }
        if (videoTexture) { gl.deleteTexture(videoTexture); videoTexture = null; }
        if (quadBuffer) {
            gl.deleteBuffer(quadBuffer.position);
            gl.deleteBuffer(quadBuffer.textureCoord);
            gl.deleteBuffer(quadBuffer.indices);
            quadBuffer = null;
        }
    }
    positionAttribLocation = texCoordAttribLocation = projectionUniformLocation = modelViewUniformLocation = textureUniformLocation = null;
    console.log("XR Session variables and WebGL resources cleared.");
}

function onXRFrame(time, frame) {
    if (!xrSession) return; 

    xrSession.requestAnimationFrame(onXRFrame); 

    const pose = frame.getViewerPose(xrRefSpace);
    if (pose && gl && xrWebGLLayer) { 
        gl.bindFramebuffer(gl.FRAMEBUFFER, xrWebGLLayer.framebuffer); // Bind once before iterating views
        gl.enable(gl.DEPTH_TEST); 
        gl.clearColor(0.1, 0.1, 0.2, 1.0); 

        for (const view of pose.views) {
            const viewport = xrWebGLLayer.getViewport(view);
            if (!viewport || viewport.width === 0 || viewport.height === 0) continue; 

            gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            
            const projectionMatrix = view.projectionMatrix;
            const viewMatrix = view.transform.inverse.matrix; 
            drawScene(projectionMatrix, viewMatrix);
        }
    }

    // --- Rover Control Logic ---
    let currentRightThumbstickInput = { pressed: false, x: 0, y: 0 };
    let generalControllerInputsForDisplay = []; // For displaying all controller data

    for (const source of frame.session.inputSources) {
        let sourceDataForDisplay = { handedness: source.handedness, profiles: source.profiles };
        if (source.gamepad) {
            sourceDataForDisplay.axes = Array.from(source.gamepad.axes);
            sourceDataForDisplay.buttons = source.gamepad.buttons.map((b, i) => ({ index: i, pressed: b.pressed, touched: b.touched, value: b.value }));

            if (source.handedness === 'right') {
                const gamepad = source.gamepad;
                // Oculus Touch/Meta Quest controllers: thumbstick press is button 3. Axes 2 & 3 are thumbstick X & Y.
                const thumbstickButton = gamepad.buttons[3]; 
                
                currentRightThumbstickInput.pressed = thumbstickButton ? thumbstickButton.pressed : false;
                currentRightThumbstickInput.x = gamepad.axes[2] || 0; 
                currentRightThumbstickInput.y = gamepad.axes[3] || 0; 
            }
        }
        if(source.gripSpace && pose) { // Get grip pose if available
            const gripPose = frame.getPose(source.gripSpace, xrRefSpace);
            if (gripPose) {
                sourceDataForDisplay.gripPosition = Array.from(gripPose.transform.position);
                sourceDataForDisplay.gripOrientation = Array.from(gripPose.transform.orientation);
            }
        }
        generalControllerInputsForDisplay.push(sourceDataForDisplay);
    }
    
    // Determine if rover input needs to be sent
    let shouldSendRoverInput = false;
    if (currentRightThumbstickInput.pressed) {
        shouldSendRoverInput = true; // Always send if pressed
    } else if (lastRightThumbstickState.pressed && !currentRightThumbstickInput.pressed) {
        shouldSendRoverInput = true; // Send one last "not pressed" state
    }
    // More precise: send if state *changed* significantly or if it's pressed.
    // This helps reduce spam if stick is idle but pressed.
    // A small deadzone for axis changes when pressed.
    const axisChangeThreshold = 0.05; 
    if (currentRightThumbstickInput.pressed && lastRightThumbstickState.pressed &&
        (Math.abs(currentRightThumbstickInput.x - lastRightThumbstickState.x) < axisChangeThreshold &&
         Math.abs(currentRightThumbstickInput.y - lastRightThumbstickState.y) < axisChangeThreshold) &&
         lastRightThumbstickState.sent // And we already sent this state
        ) {
        // If pressed, and axes haven't changed much from last *sent* state, don't resend.
        // shouldSendRoverInput = false; // Comment this out to send every frame while pressed.
                                       // Sending every frame is safer for ESP timeout.
    }


    if (shouldSendRoverInput || currentRightThumbstickInput.pressed) { // Send if state changed or actively pressed
        if (ws && ws.readyState === WebSocket.OPEN) {
            const payload = {
                pressed: currentRightThumbstickInput.pressed,
                // Send 0 for axes if not pressed, to make ESP logic simpler for "stop"
                x: currentRightThumbstickInput.pressed ? currentRightThumbstickInput.x : 0,
                y: currentRightThumbstickInput.pressed ? currentRightThumbstickInput.y : 0
            };
            ws.send(JSON.stringify({ type: 'rover_stick_input', input: payload }));
            lastRightThumbstickState.sent = true; // Mark that we've sent data for this pressed state
        }
    } else {
        lastRightThumbstickState.sent = false; // Reset if not sending (e.g. thumbstick released and stop already sent)
    }

    // Update last known state
    lastRightThumbstickState.pressed = currentRightThumbstickInput.pressed;
    lastRightThumbstickState.x = currentRightThumbstickInput.x;
    lastRightThumbstickState.y = currentRightThumbstickInput.y;

    // Update the on-page display
    let displayInfo = {
        timestamp: time.toFixed(2),
        xr_visibility: xrSession ? xrSession.visibilityState : "N/A",
        // all_controller_inputs: generalControllerInputsForDisplay, // Can be very verbose
        rover_input_detail: { // Specifics for what was used for rover
            active_input: currentRightThumbstickInput,
            last_sent_state_is_pressed: lastRightThumbstickState.sent && lastRightThumbstickState.pressed
        }
    };
    updateControllerInfo(displayInfo);
}

// Initial checks for HTTPS
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    console.warn('WebXR typically requires HTTPS to function correctly, except on localhost.');
    updateStatus('Warning: Page is not HTTPS. WebXR might not work.', true)
}
