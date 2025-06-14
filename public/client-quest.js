// --- START OF FILE public/client-quest.js ---

const remoteStreamImg = document.getElementById('remoteStreamImg'); // This <img> is still used as the source for the texture
const connectButton = document.getElementById('connectButton');
const enterVRButton = document.getElementById('enterVRButton');
const statusDiv = document.getElementById('status');
const controllerInfoDiv = document.getElementById('controllerInfo');

let xrCanvas; // Will hold the reference to the WebXR canvas
let gl = null; // WebGL rendering context

// WebGL resources for rendering the video quad
let shaderProgram = null;
let videoTexture = null;
let quadBuffer = null; // Object to hold position, texCoord, and index buffers
let positionAttribLocation = null;
let texCoordAttribLocation = null;
let projectionUniformLocation = null;
let modelViewUniformLocation = null;
let textureUniformLocation = null;

// WebSocket and WebXR session variables
let ws;
let xrSession = null;
let xrRefSpace = null;
let xrWebGLLayer = null;

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
                // Fallback: create dynamically if not in HTML, though it should be.
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
                // data.url is the ORIGINAL IP Webcam URL (e.g., http://PHONE_IP:PORT/video)
                // This is useful for status messages, but the <img> src will be the proxy.
                if (data.url && typeof data.url === 'string') {
                    const originalUrl = data.url; // Keep for display/debug
                    const streamSrc = '/proxied-stream'; // ALWAYS use the proxied path

                    updateStatus(`IP Webcam URL set (via proxy): ${originalUrl}`);
                    console.log("QUEST DEBUG: Setting img src to PROXIED PATH:", streamSrc, " (Original:", originalUrl, ")");
                    
                    // Clear previous src to help ensure the browser re-fetches if the underlying stream changes
                    // especially if the URL '/proxied-stream' itself doesn't change.
                    remoteStreamImg.src = ''; 
                    remoteStreamImg.src = streamSrc; 
                    
                    remoteStreamImg.alt = "Streaming (proxied) from " + originalUrl;

                    remoteStreamImg.onerror = function() {
                        console.error("QUEST DEBUG: Error loading image from PROXIED src:", remoteStreamImg.src);
                        updateStatus(`Error loading proxied stream. Original: ${originalUrl}. Check server logs & IP Cam.`, true);
                        remoteStreamImg.alt = `Failed to load proxied stream. Original: ${originalUrl}`;
                    };
                    remoteStreamImg.onload = function() {
                        console.log("QUEST DEBUG: Image loaded successfully from PROXIED src:", remoteStreamImg.src);
                        updateStatus(`Streaming (proxied) from ${originalUrl}`);
                        // Update video texture if in VR
                        if (xrSession && videoTexture && gl) {
                            updateVideoTexture();
                        }
                    };
                } else {
                    updateStatus('Received invalid or empty IP Webcam URL. Stream will not start.', true);
                    remoteStreamImg.src = "#"; // Use a placeholder or clear
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
            case 'error': // Errors sent from WebSocket server
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
        remoteStreamImg.src = "#"; // Clear image on disconnect
        remoteStreamImg.alt = "Disconnected. Refresh to connect.";
        ws = null;
        if (xrSession) { // If VR was active, ensure it's cleaned up
            onXRSessionEnded();
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('WebSocket connection error. Check server and network.', true);
        // onclose will likely be called too, handling UI updates
    };
}

// --- WebGL Shader and Resource Management ---

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

    // Quad placed a bit in front of the viewer
    // Adjusted size for better viewing: X width 4, Y height 3, at Z -5
    const positions = [
        -2.0, -1.5, -5.0,  // Bottom left
         2.0, -1.5, -5.0,  // Bottom right
         2.0,  1.5, -5.0,  // Top right
        -2.0,  1.5, -5.0   // Top left
    ];
    const textureCoords = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]; // BL, BR, TR, TL
    const indices = [0, 1, 2, 0, 2, 3]; // Two triangles

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
    
    // Initialize with a placeholder texture (e.g., a 1x1 blue pixel)
    // This prevents "texture not complete" errors if the image isn't loaded yet.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 255, 255]));

    return true;
}

function updateVideoTexture() {
    // Ensure gl, texture, and image are valid and image has dimensions
    if (!gl || !videoTexture || !remoteStreamImg.complete || !remoteStreamImg.naturalWidth || remoteStreamImg.naturalWidth === 0) {
        return;
    }
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, remoteStreamImg);
    // Mipmaps not strictly necessary for a 2D quad unless it's very far away or at sharp angles.
    // if (isPowerOfTwo(remoteStreamImg.width) && isPowerOfTwo(remoteStreamImg.height)) {
    //    gl.generateMipmap(gl.TEXTURE_2D);
    // }
}
// function isPowerOfTwo(value) { return (value & (value - 1)) === 0; }


function drawScene(projectionMatrix, modelViewMatrix) {
    if (!gl || !shaderProgram || !quadBuffer || !videoTexture) {
        console.warn("drawScene: Missing WebGL resources.");
        return;
    }

    updateVideoTexture(); // Update texture from the <img> tag

    gl.useProgram(shaderProgram);

    gl.uniformMatrix4fv(projectionUniformLocation, false, projectionMatrix);
    gl.uniformMatrix4fv(modelViewUniformLocation, false, modelViewMatrix);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer.position);
    gl.vertexAttribPointer(positionAttribLocation, 3, gl.FLOAT, false, 0, 0); // 3 components per vertex
    gl.enableVertexAttribArray(positionAttribLocation);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer.textureCoord);
    gl.vertexAttribPointer(texCoordAttribLocation, 2, gl.FLOAT, false, 0, 0); // 2 components per vertex
    gl.enableVertexAttribArray(texCoordAttribLocation);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.uniform1i(textureUniformLocation, 0); // Tell shader to use texture unit 0

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadBuffer.indices);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0); // 6 indices for 2 triangles

    // Clean up bound attributes (good practice)
    gl.disableVertexAttribArray(positionAttribLocation);
    gl.disableVertexAttribArray(texCoordAttribLocation);
}

// --- WebXR Session Management ---
enterVRButton.addEventListener('click', async () => {
    if (!xrSession) { // Start new session
        if (navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')) {
            try {
                xrSession = await navigator.xr.requestSession('immersive-vr');
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

                if (!initWebGLResources()) { // Initialize shaders, buffers, texture
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

                xrRefSpace = await xrSession.requestReferenceSpace('local'); // 'local' or 'viewer'
                updateStatus('VR Reference Space Acquired.');

                xrSession.requestAnimationFrame(onXRFrame);
                updateStatus('VR Session Started & Render Loop Active');
                enterVRButton.textContent = 'Exit VR';

            } catch (e) {
                console.error('Failed to start XR session:', e);
                updateStatus(`Failed to start XR session: ${e.name} - ${e.message}`, true);
                if (xrSession) { // Cleanup if partially started
                    try { await xrSession.end(); } catch (endErr) { console.error("Error ending session after failed start:", endErr); }
                }
                xrSession = null; // Reset
            }
        } else {
            updateStatus('Immersive VR not supported or WebXR not available.', true);
        }
    } else { // End existing session
        try {
            await xrSession.end();
            // onXRSessionEnded will be called by the 'end' event listener
        } catch (e) {
            console.error("Error ending XR session:", e);
            onXRSessionEnded(); // Call manually if end() fails to ensure cleanup
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
    
    // Clean up WebGL resources
    if (gl) { // Check if gl context was ever created
        if (shaderProgram) { gl.deleteProgram(shaderProgram); shaderProgram = null; }
        if (videoTexture) { gl.deleteTexture(videoTexture); videoTexture = null; }
        if (quadBuffer) {
            gl.deleteBuffer(quadBuffer.position);
            gl.deleteBuffer(quadBuffer.textureCoord);
            gl.deleteBuffer(quadBuffer.indices);
            quadBuffer = null;
        }
        // gl = null; // Don't nullify gl itself unless canvas is removed, can be reused.
    }
    positionAttribLocation = null; // etc. for all GL locations
    texCoordAttribLocation = null;
    projectionUniformLocation = null;
    modelViewUniformLocation = null;
    textureUniformLocation = null;

    console.log("XR Session variables and WebGL resources cleared.");
}

function onXRFrame(time, frame) {
    if (!xrSession) return; // Session ended or not started

    xrSession.requestAnimationFrame(onXRFrame); // Keep the loop going for the next frame

    const pose = frame.getViewerPose(xrRefSpace);
    if (pose && gl && xrWebGLLayer) { // Ensure all necessary components are available
        gl.enable(gl.DEPTH_TEST); // Enable depth testing

        for (const view of pose.views) {
            const viewport = xrWebGLLayer.getViewport(view);
            if (!viewport || viewport.width === 0 || viewport.height === 0) continue; // Skip if viewport is invalid

            gl.bindFramebuffer(gl.FRAMEBUFFER, xrWebGLLayer.framebuffer);
            gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
            
            // Clear the background for this view
            gl.clearColor(0.1, 0.1, 0.2, 1.0); // Dark blueish background
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            
            // Get projection and view matrices from the XRView
            const projectionMatrix = view.projectionMatrix;
            const viewMatrix = view.transform.inverse.matrix; // Camera's view matrix

            // Draw the video quad using these matrices
            drawScene(projectionMatrix, viewMatrix);
        }
    }

    // Controller input processing (remains the same)
    const inputSources = frame.session.inputSources;
    let controllerData = { timestamp: time, inputs: [] };
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
    }
    if (controllerData.inputs.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'controller_input', input: controllerData }));
    }
}

// Initial checks for HTTPS (important for WebXR deployment)
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    console.warn('WebXR typically requires HTTPS to function correctly, except on localhost.');
    updateStatus('Warning: Page is not HTTPS. WebXR might not work.', true)
}

// --- END OF FILE public/client-quest.js ---
