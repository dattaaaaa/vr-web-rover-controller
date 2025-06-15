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

let lastSentRoverCommand = "STOP"; // Variable to track the last sent command for the rover

function updateStatus(message, isError = false) {
    console.log(message); // Keep console log for debugging
    if (statusDiv) {
        statusDiv.textContent = `Status: ${message}`;
        statusDiv.style.color = isError ? 'red' : 'inherit';
    }
}

function updateControllerInfo(data) {
    // This function will be called with raw controller data.
    // We augment it with the lastSentRoverCommand for display.
    if (controllerInfoDiv) {
        let displayData = { ...data };
        if (xrSession) { // Only show active rover command if in VR session
            displayData.activeRoverCommand = lastSentRoverCommand;
        }
        controllerInfoDiv.textContent = JSON.stringify(displayData, null, 2);
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
                console.warn("Dynamically created XR canvas. Ensure it's in quest.html.");
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
                    updateStatus(`IP Webcam URL received: ${originalUrl} (using ${data.useProxy ? 'proxy' : 'direct'} path: ${streamSrc})`);
                    console.log("QUEST DEBUG: Setting img src to:", streamSrc, "(Original:", originalUrl, ")");
                    
                    remoteStreamImg.src = ''; 
                    remoteStreamImg.src = streamSrc; 
                    remoteStreamImg.alt = `Streaming (${data.useProxy ? 'proxied' : 'direct'}) from ${originalUrl}`;

                    remoteStreamImg.onerror = function() {
                        console.error("QUEST DEBUG: Error loading image from src:", remoteStreamImg.src);
                        updateStatus(`Error loading stream from ${remoteStreamImg.src}. Original: ${originalUrl}. Check server logs & IP Cam.`, true);
                        remoteStreamImg.alt = `Failed to load: ${remoteStreamImg.src}. Original: ${originalUrl}`;
                    };
                    remoteStreamImg.onload = function() {
                        console.log("QUEST DEBUG: Image loaded successfully from src:", remoteStreamImg.src);
                        updateStatus(`Streaming (${data.useProxy ? 'proxied' : 'direct'}) from ${originalUrl}`);
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
            case 'controller_input': // This is the echo of raw controller data
                updateControllerInfo(data.input); // Update display with echoed raw data + lastSentRoverCommand
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
        if (xrSession) {
            onXRSessionEnded(); // Clean up VR if session was active
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('WebSocket connection error. Check server and network.', true);
    };
}

// --- WebGL Shader and Resource Management (Simplified for brevity, use your existing robust one) ---
function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Error compiling shader:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader); return null;
    }
    return shader;
}

function createShaderProgram(gl) {
    const vertexShaderSource = `
        attribute vec4 aVertexPosition; attribute vec2 aTextureCoord;
        uniform mat4 uModelViewMatrix; uniform mat4 uProjectionMatrix;
        varying vec2 vTextureCoord;
        void main() { gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition; vTextureCoord = aTextureCoord; }`;
    const fragmentShaderSource = `
        precision mediump float; varying vec2 vTextureCoord; uniform sampler2D uSampler;
        void main() { gl_FragColor = texture2D(uSampler, vTextureCoord); }`;
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vertexShader || !fragmentShader) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader); gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Error linking shader program:', gl.getProgramInfoLog(program)); return null;
    }
    return program;
}

function initWebGLResources() {
    if (!gl) { console.error("initWebGLResources: WebGL context not available."); return false; }
    shaderProgram = createShaderProgram(gl);
    if (!shaderProgram) { updateStatus('Failed to create shader program', true); return false; }

    positionAttribLocation = gl.getAttribLocation(shaderProgram, 'aVertexPosition');
    texCoordAttribLocation = gl.getAttribLocation(shaderProgram, 'aTextureCoord');
    projectionUniformLocation = gl.getUniformLocation(shaderProgram, 'uProjectionMatrix');
    modelViewUniformLocation = gl.getUniformLocation(shaderProgram, 'uModelViewMatrix');
    textureUniformLocation = gl.getUniformLocation(shaderProgram, 'uSampler');

    const positions = [-2.0, -1.5, -5.0, 2.0, -1.5, -5.0, 2.0, 1.5, -5.0, -2.0, 1.5, -5.0];
    const textureCoords = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0];
    const indices = [0, 1, 2, 0, 2, 3];

    quadBuffer = { position: gl.createBuffer(), textureCoord: gl.createBuffer(), indices: gl.createBuffer() };
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer.position); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer.textureCoord); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(textureCoords), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadBuffer.indices); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

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
    if (!gl || !videoTexture || !remoteStreamImg.complete || !remoteStreamImg.naturalWidth || remoteStreamImg.naturalWidth === 0) return;
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, remoteStreamImg);
}

function drawScene(projectionMatrix, modelViewMatrix) {
    if (!gl || !shaderProgram || !quadBuffer || !videoTexture) return;
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
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.uniform1i(textureUniformLocation, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadBuffer.indices);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.disableVertexAttribArray(positionAttribLocation); gl.disableVertexAttribArray(texCoordAttribLocation);
}


// --- WebXR Session Management ---
enterVRButton.addEventListener('click', async () => {
    if (!xrSession) {
        if (navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')) {
            try {
                xrSession = await navigator.xr.requestSession('immersive-vr');
                updateStatus('VR Session Requested...');
                if (!xrCanvas) { updateStatus("XR Canvas not found.", true); await xrSession.end(); xrSession = null; return; }
                gl = xrCanvas.getContext('webgl', { xrCompatible: true });
                if (!gl) { updateStatus("Failed to get WebGL context for XR.", true); await xrSession.end(); xrSession = null; return; }
                await gl.makeXRCompatible();
                if (!initWebGLResources()) { updateStatus("Failed to init WebGL resources.", true); await xrSession.end(); xrSession = null; return; }

                xrWebGLLayer = new XRWebGLLayer(xrSession, gl);
                await xrSession.updateRenderState({ baseLayer: xrWebGLLayer });
                xrSession.addEventListener('end', onXRSessionEnded);
                xrRefSpace = await xrSession.requestReferenceSpace('local');
                xrSession.requestAnimationFrame(onXRFrame);
                updateStatus('VR Session Started & Render Loop Active');
                enterVRButton.textContent = 'Exit VR';
            } catch (e) {
                console.error('Failed to start XR session:', e);
                updateStatus(`Failed to start XR: ${e.message}`, true);
                if (xrSession) { try { await xrSession.end(); } catch (ee) {} }
                xrSession = null;
            }
        } else { updateStatus('Immersive VR not supported.', true); }
    } else {
        try { await xrSession.end(); } catch (e) { onXRSessionEnded(); }
    }
});

function onXRSessionEnded() {
    updateStatus('VR Session Ended');
    if (enterVRButton) enterVRButton.textContent = 'Enter VR';
    if (controllerInfoDiv) controllerInfoDiv.textContent = 'Exited VR. Controller input paused.';
    
    xrSession = null; xrRefSpace = null; xrWebGLLayer = null;
    if (gl) {
        if (shaderProgram) { gl.deleteProgram(shaderProgram); shaderProgram = null; }
        if (videoTexture) { gl.deleteTexture(videoTexture); videoTexture = null; }
        if (quadBuffer) {
            gl.deleteBuffer(quadBuffer.position); gl.deleteBuffer(quadBuffer.textureCoord); gl.deleteBuffer(quadBuffer.indices);
            quadBuffer = null;
        }
    }
    // Reset attribute/uniform locations too if desired, though they become invalid with shaderProgram=null
    lastSentRoverCommand = "STOP"; // Reset rover command on VR exit
    console.log("XR Session variables and WebGL resources cleared.");
}

function getRoverCommand(stickX, stickY) {
    const deadzone = 0.25; // Increased deadzone for more deliberate control
    const strongThreshold = 0.7; // For differentiating strong pushes

    // Y-axis: -1 up (forward), +1 down (backward)
    // X-axis: -1 left, +1 right

    if (Math.abs(stickY) < deadzone && Math.abs(stickX) < deadzone) return "STOP";

    // Forward movement priority
    if (stickY < -deadzone) { // Moving thumbstick forward
        if (Math.abs(stickX) < deadzone) return "MOVE_FORWARD";
        if (stickX > deadzone) return "PIVOT_LEFT_FORWARD";  // Forward + Right on stick = Rover turns right (left motors forward, right stop/slower)
        if (stickX < -deadzone) return "PIVOT_RIGHT_FORWARD"; // Forward + Left on stick = Rover turns left (right motors forward, left stop/slower)
    }
    // Backward movement
    else if (stickY > deadzone) { // Moving thumbstick backward
        if (Math.abs(stickX) < deadzone) return "MOVE_BACKWARD";
        // Can add pivoting backward commands if needed, e.g., PIVOT_LEFT_BACKWARD
    }
    // Spot turning (no significant forward/backward movement)
    else if (Math.abs(stickY) < deadzone) {
        if (stickX > strongThreshold) return "TURN_RIGHT_ON_SPOT"; // Strong right on stick
        if (stickX < -strongThreshold) return "TURN_LEFT_ON_SPOT";  // Strong left on stick
    }
    return "STOP"; // Default if conditions aren't met cleanly
}


function onXRFrame(time, frame) {
    if (!xrSession) return;
    xrSession.requestAnimationFrame(onXRFrame);

    const pose = frame.getViewerPose(xrRefSpace);
    if (pose && gl && xrWebGLLayer) {
        gl.enable(gl.DEPTH_TEST);
        for (const view of pose.views) {
            const viewport = xrWebGLLayer.getViewport(view);
            if (!viewport || viewport.width === 0 || viewport.height === 0) continue;
            gl.bindFramebuffer(gl.FRAMEBUFFER, xrWebGLLayer.framebuffer);
            gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
            gl.clearColor(0.1, 0.1, 0.2, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            drawScene(view.projectionMatrix, view.transform.inverse.matrix);
        }
    }

    // Controller Input and Rover Command Logic
    const inputSources = frame.session.inputSources;
    let rawControllerData = { timestamp: time, inputs: [] };
    let rightController = null;
    let rightThumbstickPressed = false;
    let currentRoverCommand = "STOP";

    for (const source of inputSources) {
        if (source.gamepad) {
            let inputDetail = {
                handedness: source.handedness,
                buttons: source.gamepad.buttons.map((b, i) => ({ index: i, pressed: b.pressed, touched: b.touched, value: b.value })),
                axes: Array.from(source.gamepad.axes)
            };
            rawControllerData.inputs.push(inputDetail);

            if (source.handedness === 'right') {
                rightController = source.gamepad;
                // Oculus Touch/Quest controllers: Thumbstick press is usually buttons[3]
                if (rightController.buttons[3] && rightController.buttons[3].pressed) {
                    rightThumbstickPressed = true;
                }
            }
        }
    }

    if (rightController && rightThumbstickPressed) {
        const stickX = rightController.axes[2]; // Right thumbstick X-axis
        const stickY = rightController.axes[3]; // Right thumbstick Y-axis
        currentRoverCommand = getRoverCommand(stickX, stickY);
    } else {
        currentRoverCommand = "STOP"; // If thumbstick not pressed or no right controller, command is STOP
    }

    // Send raw controller data for display (if there's any input)
    if (rawControllerData.inputs.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'controller_input', input: rawControllerData }));
    }
    
    // Update local display (will use the new currentRoverCommand via lastSentRoverCommand)
    // The received 'controller_input' message will also call updateControllerInfo.
    // To avoid confusion, let's primarily update from the echo.
    // However, we must update lastSentRoverCommand IF it changes.

    if (currentRoverCommand !== lastSentRoverCommand) {
        lastSentRoverCommand = currentRoverCommand; // Update global state for display via updateControllerInfo
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'rover_command', command: lastSentRoverCommand }));
            console.log(`Rover command sent: ${lastSentRoverCommand}`);
        }
    }
    // The controllerInfoDiv will be updated by the 'controller_input' echo using this fresh lastSentRoverCommand.
}


// Initial checks
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    console.warn('WebXR typically requires HTTPS to function correctly, except on localhost.');
    updateStatus('Warning: Page is not HTTPS. WebXR might not work.', true)
}

// --- END OF FILE public/client-quest.js ---
