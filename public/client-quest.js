// --- START OF FILE public/client-quest.js ---

const remoteStreamImg = document.getElementById('remoteStreamImg');
const connectButton = document.getElementById('connectButton');
const enterVRButton = document.getElementById('enterVRButton');
const statusDiv = document.getElementById('status'); // For non-VR status
const controllerInfoDiv = document.getElementById('controllerInfo'); // For non-VR controller data
const vrControllerOverlay = document.getElementById('vrControllerOverlay'); // For VR controller data overlay

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

// For simple text display in VR (using HTML overlay method)
let currentVrText = ""; 

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

function updateControllerInfo(data) { // For non-VR display
    controllerInfoDiv.textContent = JSON.stringify(data, null, 2);
}

function updateVRControllerOverlay(text) {
    if (vrControllerOverlay && xrSession) {
        vrControllerOverlay.textContent = text;
        vrControllerOverlay.style.display = 'block';
    } else if (vrControllerOverlay) {
        vrControllerOverlay.style.display = 'none';
    }
}


connectButton.addEventListener('click', () => {
    connectButton.disabled = true;
    updateStatus('Connecting to server...');
    setupWebSocket();
});

function setupWebSocket() {
    // ... (ws setup, onopen, onmessage (for stream URL), onclose, onerror remains largely the same) ...
    // Make sure onopen shows enterVRButton correctly
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
                console.error("XR Canvas not found! Critical for WebXR.");
                updateStatus("XR Canvas element missing from HTML.", true);
                return;
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

                    updateStatus(`IP Webcam URL set: ${originalUrl} (Using ${data.useProxy ? 'proxy' : 'direct'})`);
                    console.log("QUEST DEBUG: Setting img src to:", streamSrc, " (Original:", originalUrl, ")");
                    
                    remoteStreamImg.src = ''; 
                    remoteStreamImg.src = streamSrc; 
                    
                    remoteStreamImg.alt = `Streaming ${data.useProxy ? '(proxied)' : ''} from ${originalUrl}`;

                    remoteStreamImg.onerror = function() {
                        console.error("QUEST DEBUG: Error loading image from src:", remoteStreamImg.src);
                        updateStatus(`Error loading stream from ${remoteStreamImg.src}. Check URL, network, and server logs.`, true);
                        remoteStreamImg.alt = `Failed to load: ${remoteStreamImg.src}`;
                    };
                    remoteStreamImg.onload = function() {
                        console.log("QUEST DEBUG: Image loaded successfully from src:", remoteStreamImg.src);
                        updateStatus(`Streaming from ${remoteStreamImg.src}`);
                        if (xrSession && videoTexture && gl) {
                            updateVideoTexture();
                        }
                    };
                } else {
                    updateStatus('Received invalid or empty IP Webcam URL.', true);
                    remoteStreamImg.src = "#"; 
                    remoteStreamImg.alt = "IP Webcam URL not set or invalid.";
                }
                break;
            case 'no_stream_url_set':
                updateStatus('No IP Webcam URL has been set on the server yet.', true);
                remoteStreamImg.src = "#";
                remoteStreamImg.alt = "IP Webcam URL not set yet on server.";
                break;
            case 'controller_input': // This is the echo from the server
                updateControllerInfo(data.input); // Update non-VR HTML display
                
                // Prepare text for VR overlay based on right thumbstick
                let vrDisplayMessage = "Right Stick: Center";
                if (data.input && data.input.inputs) {
                    let stickX = 0;
                    let stickY = 0;
                    for (const controller of data.input.inputs) {
                        if (controller.handedness === 'right') {
                            if (controller.axes && controller.axes.length >= 4) {
                                stickX = controller.axes[2];
                                stickY = controller.axes[3];
                                vrDisplayMessage = `Right Stick: X=${stickX.toFixed(2)}, Y=${stickY.toFixed(2)}`;
                                break;
                            }
                        }
                    }
                     // Fallback if no 'right' handedness found
                    if (vrDisplayMessage === "Right Stick: Center" && data.input.inputs.length > 0) {
                        const firstController = data.input.inputs[0];
                        if (firstController.axes && firstController.axes.length >=4) {
                            stickX = firstController.axes[2];
                            stickY = firstController.axes[3];
                            vrDisplayMessage = `Stick (${firstController.handedness || 'unknown'}): X=${stickX.toFixed(2)}, Y=${stickY.toFixed(2)}`;
                        } else if (firstController.axes && firstController.axes.length >=2) {
                            stickX = firstController.axes[0];
                            stickY = firstController.axes[1];
                            vrDisplayMessage = `Stick (${firstController.handedness || 'unknown'}): X=${stickX.toFixed(2)}, Y=${stickY.toFixed(2)}`;
                        }
                    }
                }
                currentVrText = vrDisplayMessage; // Store for onXRFrame
                if (xrSession) {
                    updateVRControllerOverlay(currentVrText);
                }
                break;
            case 'error': 
                updateStatus(`Server error: ${data.message}`, true);
                break;
            default:
                // console.log("Unknown message from server:", data);
        }
    };

    ws.onclose = (event) => {
        updateStatus(`Disconnected from server (Code: ${event.code}). Please refresh.`, true);
        connectButton.disabled = false;
        connectButton.style.display = 'inline-block';
        enterVRButton.style.display = 'none';
        remoteStreamImg.src = "#"; 
        remoteStreamImg.alt = "Disconnected. Refresh to connect.";
        ws = null;
        if (xrSession) { 
            updateVRControllerOverlay("Disconnected");
            // onXRSessionEnded will be called by the session 'end' event
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('WebSocket connection error. Check server and network.', true);
    };
}


// --- WebGL Shader and Resource Management (initWebGLResources, updateVideoTexture, drawScene) ---
// These remain largely the same as your `client-quest.js` from the prompt.
// Make sure createShaderProgram, initWebGLResources, updateVideoTexture, drawScene are present and correct.
// I'll put placeholders here - copy them from your working `client-quest.js`
function createShader(gl, type, source) { /* ... your existing code ... */ 
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

function createShaderProgram(gl) { /* ... your existing code ... */ 
    const vertexShaderSource = `
        attribute vec4 aVertexPosition;
        attribute vec2 aTextureCoord;
        uniform mat4 uModelViewMatrix;
        uniform mat4 uProjectionMatrix;
        varying vec2 vTextureCoord;
        void main() {
            gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
            vTextureCoord = aTextureCoord; /* Flip Y for video texture if needed: vec2(aTextureCoord.x, 1.0 - aTextureCoord.y); */
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

function initWebGLResources() { /* ... your existing code ... */
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

    const positions = [ // Quad filling more of the view, adjust Z as needed
        -2.0, -1.5, -3.0, // Bottom left
         2.0, -1.5, -3.0, // Bottom right
         2.0,  1.5, -3.0, // Top right
        -2.0,  1.5, -3.0  // Top left
    ]; // X, Y, Z. Z = -3 is 3 units in front. Width 4, Height 3.
    const textureCoords = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]; // Standard UVs BL, BR, TR, TL
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

function updateVideoTexture() { /* ... your existing code ... */
    if (!gl || !videoTexture || !remoteStreamImg.complete || !remoteStreamImg.naturalWidth || remoteStreamImg.naturalWidth === 0) {
        return;
    }
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    // TexImage2D might flip image, if so, adjust UVs or use gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); before texImage2D
    // gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // <--- Add this if video is upside down
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, remoteStreamImg);
    // gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // <--- And reset after
}

function drawScene(projectionMatrix, modelViewMatrix) { /* ... your existing code ... */
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
    // ... (This logic remains mostly the same) ...
    // Make sure to call updateVRControllerOverlay("Entering VR...") or similar
    // And in onXRSessionEnded, hide it or set text to "Exited VR"
    if (!xrSession) {
        if (navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')) {
            try {
                xrSession = await navigator.xr.requestSession('immersive-vr', {
                    // optionalFeatures: ['local-floor', 'bounded-floor'] // if you need specific reference spaces
                });
                updateStatus('VR Session Requested...');
                updateVRControllerOverlay("Entering VR...");


                if (!xrCanvas) { /* ... error handling ... */ return; }
                gl = xrCanvas.getContext('webgl', { xrCompatible: true });
                if (!gl) { /* ... error handling ... */ await xrSession.end(); xrSession = null; return;}
                await gl.makeXRCompatible();

                if (!initWebGLResources()) { /* ... error handling ... */ await xrSession.end(); xrSession = null; return; }
                
                // Hide non-VR controls and stream image if it's not meant to be visible
                document.querySelector('.non-vr-controls').style.display = 'none';
                // remoteStreamImg.style.display = 'none'; // If only used for texture


                xrWebGLLayer = new XRWebGLLayer(xrSession, gl);
                await xrSession.updateRenderState({ baseLayer: xrWebGLLayer });
                
                xrSession.addEventListener('end', onXRSessionEnded);
                // ... other event listeners ...

                xrRefSpace = await xrSession.requestReferenceSpace('local'); 
                
                xrSession.requestAnimationFrame(onXRFrame);
                updateStatus('VR Session Started & Render Loop Active');
                enterVRButton.textContent = 'Exit VR';

            } catch (e) {
                console.error('Failed to start XR session:', e);
                updateStatus(`Failed to start XR session: ${e.message}`, true);
                updateVRControllerOverlay(`VR Error: ${e.message}`);
                if (xrSession) { try { await xrSession.end(); } catch (endErr) { /* ignore */ } }
                xrSession = null;
            }
        } else { /* ... error handling ... */ }
    } else {
        try {
            await xrSession.end(); // onXRSessionEnded will be called
        } catch (e) { /* ... error handling ... */ onXRSessionEnded(); }
    }
});

function onXRSessionEnded() {
    updateStatus('VR Session Ended');
    if (enterVRButton) enterVRButton.textContent = 'Enter VR';
    updateControllerInfo('Exited VR. Controller input paused.'); // Non-VR display
    updateVRControllerOverlay("Exited VR"); // Hide or update VR overlay
    
    // Show non-VR controls again
    document.querySelector('.non-vr-controls').style.display = 'block';
    // remoteStreamImg.style.display = 'block'; // If it was hidden


    xrSession = null;
    xrRefSpace = null;
    xrWebGLLayer = null;
    
    // Clean up WebGL resources if any (shaderProgram, videoTexture, quadBuffer)
    // ... (your existing cleanup) ...
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
    // Wait a moment then hide overlay
    setTimeout(() => { if (!xrSession) updateVRControllerOverlay(""); }, 2000);
}

function onXRFrame(time, frame) {
    if (!xrSession) return;
    xrSession.requestAnimationFrame(onXRFrame);

    const pose = frame.getViewerPose(xrRefSpace);
    if (pose && gl && xrWebGLLayer) {
        // Update VR overlay text (already set by ws.onmessage for 'controller_input')
        // updateVRControllerOverlay(currentVrText); // No need to call it every frame if data comes via WS

        gl.bindFramebuffer(gl.FRAMEBUFFER, xrWebGLLayer.framebuffer);
        gl.clearColor(0.1, 0.1, 0.1, 1.0); // Background color for XR scene
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        
        for (const view of pose.views) {
            const viewport = xrWebGLLayer.getViewport(view);
            if (!viewport || viewport.width === 0 || viewport.height === 0) continue;

            gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
            drawScene(view.projectionMatrix, view.transform.inverse.matrix);

            // ---- WebGL Text Rendering (Placeholder) ----
            // This is where you would render `currentVrText` onto a quad in front of the camera.
            // For now, the HTML overlay #vrControllerOverlay handles this.
            // To do it in WebGL:
            // 1. Create a 2D canvas element dynamically.
            // 2. Set its font, fillStyle, and use fillText() to draw currentVrText.
            // 3. Create a WebGL texture from this 2D canvas.
            // 4. Create a new shader program for text (or a complex one that handles both video and text).
            // 5. Draw a quad (like a billboard) in front of the camera using the text texture.
            // This needs to be done carefully to manage resources and performance.
        }
    }

    // Controller input processing
    const inputSources = frame.session.inputSources;
    let controllerDataForServer = { timestamp: time, inputs: [] }; // Renamed to avoid confusion
    // This loop primarily sends data to server, server echoes for local display

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
            controllerDataForServer.inputs.push(inputDetail);
        }
    }
    if (controllerDataForServer.inputs.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        // This data is sent to the server. The server will then echo it back
        // with type 'controller_input', which then updates the vrControllerOverlay.
        ws.send(JSON.stringify({ type: 'controller_input', input: controllerDataForServer }));
    }
}

// Initial checks for HTTPS (important for WebXR deployment)
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    console.warn('WebXR typically requires HTTPS to function correctly, except on localhost.');
    updateStatus('Warning: Page is not HTTPS. WebXR might not work or might have limitations.', true)
}

// --- END OF FILE public/client-quest.js ---
