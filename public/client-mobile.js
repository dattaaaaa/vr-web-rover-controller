const ipWebcamUrlInput = document.getElementById('ipWebcamUrl');
const setStreamUrlButton = document.getElementById('setStreamUrlButton');
const statusDiv = document.getElementById('status');

let ws;
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

function updateStatus(message, isError = false) {
    console.log(message);
    statusDiv.textContent = `Status: ${message}`;
    statusDiv.style.color = isError ? 'red' : 'inherit';
}

function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log("WebSocket already open or connecting.");
        return;
    }

    ws = new WebSocket(WS_URL);
    updateStatus('Connecting to server...');
    setStreamUrlButton.disabled = true;


    ws.onopen = () => {
        updateStatus('Connected to server. Ready to set URL.');
        setStreamUrlButton.disabled = false;
        ws.send(JSON.stringify({ type: 'register_mobile_configurator' }));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Mobile Config WS received:', data);
        if (data.type === 'url_ack') {
            updateStatus(`URL successfully set/retrieved on server: ${data.url}`);
            if (data.url && ipWebcamUrlInput.value !== data.url) {
                ipWebcamUrlInput.value = data.url; // Populate if server had a URL
            }
        } else if (data.type === 'error') {
            updateStatus(`Server error: ${data.message}`, true);
        }
    };

    ws.onclose = (event) => {
        updateStatus(`Disconnected from server (Code: ${event.code}). Attempting to reconnect in 5s...`, true);
        setStreamUrlButton.disabled = true;
        ws = null; // Clear the ws object
        setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        // onclose will likely be called too, handling reconnect
        updateStatus('WebSocket connection error. Check server and network.', true);
        setStreamUrlButton.disabled = true;
    };
}

setStreamUrlButton.addEventListener('click', () => {
    const url = ipWebcamUrlInput.value.trim();
    if (!url) {
        updateStatus('Please enter a valid IP Webcam URL.', true);
        return;
    }

    if (!url.startsWith('http://')) { // IP Cams on local network are almost always HTTP
        updateStatus('URL should typically start with http:// for local IP webcams.', true);
        // return; // Comment out to allow https if user really has it locally
    }
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        updateStatus(`Sending URL to server: ${url}`);
        ws.send(JSON.stringify({ type: 'set_ip_webcam_url', url: url }));
    } else {
        updateStatus('Not connected to server. Please wait or refresh.', true);
        connectWebSocket(); // Attempt to reconnect if not connected
    }
});

// Initialize WebSocket connection when the page loads
connectWebSocket();
