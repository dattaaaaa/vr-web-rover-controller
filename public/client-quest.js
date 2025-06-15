// Quest IP Cam Viewer - WebXR Implementation
const remoteStreamImg = document.getElementById('remoteStreamImg');
const connectButton = document.getElementById('connectButton');
const enterVRButton = document.getElementById('enterVRButton');
const statusDiv = document.getElementById('status');
const controllerInfoDiv = document.getElementById('controllerInfo');
const nonVrUiContainer = document.getElementById('nonVrUiContainer');
const vrControllerOverlay = document.getElementById('vrControllerOverlay');
const xrCanvas = document.getElementById('xrCanvas');

let gl = null;
let shaderProgram = null;
let videoTexture = null;
let quadBuffer = null;
let programInfo = null;

let ws = null;
let xrSession = null;
let xrRefSpace = null;
let xrWebGLLayer = null;
let currentVrText = "";

const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

// Utility functions
function updateStatus(message, isError = false) {
    console.log(message);
    statusDiv.textContent = `Status: ${message}`;
    statusDiv.style.color = isError ? 'red' : (message.includes("Warning") ? '#FFEB3B' : '#4CAF50');
}

function updateControllerInfo(data) {
    controllerInfoDiv.textContent = JSON.stringify(data, null, 2);
}

function updateVRControllerOverlay(text) {
    if (vrControllerOverlay) {
        if (xrSession && text) {
            vrControllerOverlay.textContent = text;
            vrControllerOverlay.style.display = 'block';
        } else {
            vrControllerOverlay.style.display = 'none';
        }
    }
}

// WebSocket setup
connectButton.addEventListener('click', () => {
    connectButton.disabled = true;
    updateStatus('Connecting to server...');
    setupWebSocket();
});

function setupWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    ws = new WebSocket(WS_URL);
    updateStatus('Attempting to connect to server...');

    ws.onopen = () => {
        updateStatus('Connected! Registering as Quest Viewer...');
        ws.send(JSON.stringify({ type: 'register_quest_viewer' }));
        connectButton.style.display = 'none';
        
        if (navigator.xr) {
            enterVRButton.style.display = 'inline-block';
            updateStatus('Ready for VR. WebXR is supported.');
        } else {
            updateStatus('WebXR not supported on this device.', true);
        }
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
            case 'ip_webcam_url_update':
                handleStreamUrl(data);
                break;
            case 'no_stream_url_set':
                updateStatus('No IP Webcam URL set on server yet.', true);
                remoteStreamImg.src = '';
                break;
            case 'controller_input':
                handleControllerInput(data);
                break;
            case 'error':
                updateStatus(`Server error: ${data.message}`, true);
                break;
        }
    };

    ws.onclose = (event) => {
        updateStatus(`Disconnected (Code: ${event.code}). Refresh to reconnect.`, true);
        connectButton.disabled = false;
        connectButton.style.display = 'inline-block';
        enterVRButton.style.display = 'none';
        remoteStreamImg.src = '';
        ws = null;
        
        if (xrSession) {
            try { xrSession.end(); } catch(e) { onXRSessionEnded(); }
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('WebSocket connection error.', true);
    };
}

function handleStreamUrl(data) {
    if (data.url && typeof data.url === 'string') {
        const streamSrc = data.useProxy ? '/proxied-stream' : data.url;
        
        updateStatus(`Stream URL received: ${data.url} (${data.useProxy ? 'proxied' : 'direct'})`);
        
        remoteStreamImg.onload = () => {
            updateStatus(`✓ Stream loaded successfully`);
            console.log('Stream loaded, dimensions:', remoteStreamImg.naturalWidth, 'x', remoteStreamImg.naturalHeight);
        };
        
        remoteStreamImg.onerror = () => {
            updateStatus(`✗ Failed to load stream from ${streamSrc}`, true);
        };
        
        remoteStreamImg.src = streamSrc;
    } else {
        updateStatus('Invalid stream URL received', true);
        remoteStreamImg.src = '';
    }
}

function handleControllerInput(data) {
    updateControllerInfo(data.input);
    
    let vrMessage = "Controllers: No input detected";
    
    if (data.input && data.input.inputs && data.input.inputs.length > 0) {
        const controllers = data.input.inputs;
        let rightController = controllers.find(c => c.handedness === 'right');
        
        if (!rightController) rightController = controllers[0]; // Fallback to first controller
        
        if (rightController && rightController.axes && rightController.axes.length >= 2) {
            const stickX = rightController.axes[rightController.axes.length >= 4 ? 2 : 0];
            const stickY = rightController.axes[rightController.axes.length >= 4 ? 3 : 1];
            vrMessage = `${rightController.handedness || 'Main'} Stick: X=${stickX.toFixed(2)}, Y=${stickY.toFixed(2)}`;
            
            // Add button info
            if (rightController.buttons && rightController.buttons.length > 0) {
                const pressedButtons = rightController.buttons
                    .map((btn, idx) => btn.pressed ? `B${idx}` : null)
                    .filter(b => b)
                    .join(',');
                if (pressedButtons) vrMessage += ` | Pressed: ${pressedButtons}`;
            }
        }
    }
    
    currentVrText = vrMessage;
    if (xrSession) {
        updateVRControllerOverlay(currentVrText);
    }
}

// WebGL Shader functions
function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createShaderProgram(gl) {
    const vertexSource = `
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
    
    const fragmentSource = `
        precision mediump float;
        varying vec2 vTextureCoord;
        uniform sampler2D uSampler;
        void main() {
            gl_FragColor = texture2D(uSampler, vTextureCoord);
        }
    `;
    
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    
    if (!vertexShader || !fragmentShader) return null;
    
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Shader program link error:', gl.getProgramInfoLog(program));
        return null;
    }
    
    return program;
}

function initWebGLResources() {
    if (!gl) {
        console.error('WebGL context not available');
        return false;
    }
    
    shaderProgram = createShaderProgram(gl);
    if (!shaderProgram) {
        updateStatus('Failed to create shader program', true);
        return false;
    }
    
    programInfo = {
        attribLocations: {
            vertexPosition: gl.getAttribLocation(shaderProgram, 'aVertexPosition'),
            textureCoord: gl.getAttribLocation(shaderProgram, 'aTextureCoord'),
        },
        uniformLocations: {
            projectionMatrix: gl.getUniformLocation(shaderProgram, 'uProjectionMatrix'),
            modelViewMatrix: gl.getUniformLocation(shaderProgram, 'uModelViewMatrix'),
            uSampler: gl.getUniformLocation(shaderProgram, 'uSampler'),
        },
    };
    
    // Create quad (rectangle) for video display
    const positions = [
        -3.0, -2.0, -5.0,  // Bottom left
         3.0, -2.0, -5.0,  // Bottom right
         3.0,  2.0, -5.0,  // Top right
        -3.0,  2.0, -5.0   // Top left
    ];
    
    const textureCoords = [
        0.0, 1.0,
        1.0, 1.0,
        1.0, 0.0,
        0.0, 0.0,
    ];
    
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
    
    // Create texture
    videoTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
    // Default texture (white square)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, 
                  new Uint8Array([255, 255, 255, 255]));
    
    return true;
}

function updateVideoTexture() {
    if (!gl || !videoTexture || !remoteStreamImg.complete || 
        !remoteStreamImg.naturalWidth || remoteStreamImg.naturalWidth === 0) {
        return;
    }
    
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, remoteStreamImg);
}

function drawScene(projectionMatrix, modelViewMatrix) {
    if (!gl || !shaderProgram || !quadBuffer || !videoTexture || !programInfo) return;
    
    updateVideoTexture();
    
    gl.useProgram(shaderProgram);
    
    // Set uniforms
    gl.uniformMatrix4fv(programInfo.uniformLocations.projectionMatrix, false, projectionMatrix);
    gl.uniformMatrix4fv(programInfo.uniformLocations.modelViewMatrix, false, modelViewMatrix);
    
    // Bind position buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer.position);
    gl.vertexAttribPointer(programInfo.attribLocations.vertexPosition, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);
    
    // Bind texture coordinate buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer.textureCoord);
    gl.vertexAttribPointer(programInfo.attribLocations.textureCoord, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(programInfo.attribLocations.textureCoord);
    
    // Bind texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.uniform1i(programInfo.uniformLocations.uSampler, 0);
    
    // Draw
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadBuffer.indices);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    
    // Cleanup
    gl.disableVertexAttribArray(programInfo.attribLocations.vertexPosition);
    gl.disableVertexAttribArray(programInfo.attribLocations.textureCoord);
}

// WebXR functions
enterVRButton.addEventListener('click', async () => {
    if (!xrSession) {
        await startVRSession();
    } else {
        await endVRSession();
    }
});

async function startVRSession() {
    if (!navigator.xr) {
        updateStatus('WebXR not supported', true);
        return;
    }
    
    try {
        const supported = await navigator.xr.isSessionSupported('immersive-vr');
        if (!supported) {
            updateStatus('Immersive VR not supported', true);
            return;
        }
        
        xrSession = await navigator.xr.requestSession('immersive-vr', {
            optionalFeatures: ['local-floor', 'bounded-floor']
        });
        
        updateStatus('VR session started...');
        updateVRControllerOverlay("Entering VR...");
        
        // Get WebGL context
        gl = xrCanvas.getContext('webgl', { xrCompatible: true });
        if (!gl) {
            throw new Error('Failed to get WebGL context');
        }
        
        await gl.makeXRCompatible();
        
        if (!initWebGLResources()) {
            throw new Error('Failed to initialize WebGL resources');
        }
        
        // Setup XR layer
        xrWebGLLayer = new XRWebGLLayer(xrSession, gl);
        await xrSession.updateRenderState({ baseLayer: xrWebGLLayer });
        
        // Setup reference space
        xrRefSpace = await xrSession.requestReferenceSpace('local');
        
        // Setup event listeners
        xrSession.addEventListener('end', onXRSessionEnded);
        
        // Hide non-VR UI
        nonVrUiContainer.style.display = 'none';
        
        // Start render loop
        xrSession.requestAnimationFrame(onXRFrame);
        
        updateStatus('✓ VR session active');
        enterVRButton.textContent = 'Exit VR';
        
    } catch (error) {
        console.error('Failed to start VR session:', error);
        updateStatus(`VR Error: ${error.message}`, true);
        updateVRControllerOverlay(`VR Error: ${error.message}`);
        
        if (xrSession) {
            try { await xrSession.end(); } catch(e) { onXRSessionEnded(); }
        }
    }
}

async function endVRSession() {
    if (xrSession) {
        try {
            await xrSession.end();
        } catch (error) {
            console.error('Error ending VR session:', error);
            onXRSessionEnded();
        }
    }
}

function onXRSessionEnded() {
    updateStatus('VR session ended');
    enterVRButton.textContent = 'Enter VR';
    updateVRControllerOverlay("");
    
    // Show non-VR UI
    nonVrUiContainer.style.display = 'block';
    
    // Reset XR variables
    xrSession = null;
    xrRefSpace = null;
    xrWebGLLayer = null;
    
    // Cleanup WebGL resources
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
    
    programInfo = null;
    console.log('XR session cleanup complete');
}

function onXRFrame(time, frame) {
    if (!xrSession) return;
    
    xrSession.requestAnimationFrame(onXRFrame);
    
    const pose = frame.getViewerPose(xrRefSpace);
    if (pose && gl && xrWebGLLayer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, xrWebGLLayer.framebuffer);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        
        for (const view of pose.views) {
            const viewport = xrWebGLLayer.getViewport(view);
            if (!viewport) continue;
            
            gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
            drawScene(view.projectionMatrix, view.transform.inverse.matrix);
        }
    }
    
    // Process controller input
    const inputSources = frame.session.inputSources;
    if (inputSources.length > 0) {
        const controllerData = {
            timestamp: time,
            inputs: []
        };
        
        for (const source of inputSources) {
            if (source.gamepad) {
                const inputDetail = {
                    handedness: source.handedness,
                    buttons: source.gamepad.buttons.map((button, index) => ({
                        index,
                        pressed: button.pressed,
                        touched: button.touched,
                        value: button.value
                    })),
                    axes: Array.from(source.gamepad.axes)
                };
                controllerData.inputs.push(inputDetail);
            }
        }
        
        if (controllerData.inputs.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'controller_input', input: controllerData }));
        }
    }
}

// HTTPS warning for WebXR
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    updateStatus('Warning: WebXR requires HTTPS except on localhost', true);
}
