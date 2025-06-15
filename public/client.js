// --- Basic Three.js Scene Setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101020);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.6, 0); // Typical standing height

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

// --- VR Scene Content ---

// A floor plane
const floorGeometry = new THREE.PlaneGeometry(10, 10);
const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x444444 });
const floor = new THREE.Mesh(floorGeometry, floorMaterial);
floor.rotation.x = -Math.PI / 2; // Rotate it to be horizontal
scene.add(floor);

// Simple lighting
const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
light.position.set(0, 4, 0);
scene.add(light);

// --- Status Text Display in VR ---
const canvas = document.createElement('canvas');
canvas.width = 512;
canvas.height = 128;
const context = canvas.getContext('2d');
const texture = new THREE.CanvasTexture(canvas);

const textMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
const textGeometry = new THREE.PlaneGeometry(2, 0.5); // Plane size in 3D space
const textMesh = new THREE.Mesh(textGeometry, textMaterial);
textMesh.position.set(0, 1.6, -3); // Position in front of the camera
scene.add(textMesh);

function updateStatusText(text) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#FFFFFF';
    context.font = '48px Arial';
    context.textAlign = 'center';
    context.fillText(text, canvas.width / 2, canvas.height / 2);
    texture.needsUpdate = true;
}

// --- MQTT Setup ---
// IMPORTANT: Replace with your HiveMQ Cloud credentials
const MQTT_OPTIONS = {
    host: 'YOUR_HIVEMQ_CLUSTER_URL.s1.eu.hivemq.cloud',
    port: 8884, // Use 8884 for secure WebSockets (wss://)
    protocol: 'wss',
    username: 'YOUR_USERNAME',
    password: 'YOUR_PASSWORD'
};
const MQTT_TOPIC = 'robot/control';
let mqttClient = null;

try {
    mqttClient = mqtt.connect(MQTT_OPTIONS);

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT Broker!');
        updateStatusText('MQTT Connected');
    });

    mqttClient.on('error', (err) => {
        console.error('MQTT Connection Error:', err);
        updateStatusText('MQTT Error');
        mqttClient.end();
    });
} catch (error) {
    console.error("Failed to initialize MQTT:", error);
    updateStatusText('MQTT Init Failed');
}

function publishCommand(command) {
    if (mqttClient && mqttClient.connected) {
        mqttClient.publish(MQTT_TOPIC, command, { qos: 0, retain: false });
        console.log(`Published: ${command}`);
    }
}

// --- Controller and Game Logic ---
let lastCommand = 'STOP';
updateStatusText(lastCommand);

function handleController(controller) {
    if (controller.gamepad) {
        const thumbstick = controller.gamepad.axes;
        // The Quest controller thumbstick is usually axes 2 and 3
        const stickX = thumbstick[2];
        const stickY = thumbstick[3];
        
        let currentCommand = 'STOP';
        const deadzone = 0.5;

        if (stickY < -deadzone) {
            currentCommand = 'FORWARD';
        } else if (stickY > deadzone) {
            currentCommand = 'BACKWARD';
        } else if (stickX < -deadzone) {
            currentCommand = 'LEFT';
        } else if (stickX > deadzone) {
            currentCommand = 'RIGHT';
        }

        if (currentCommand !== lastCommand) {
            lastCommand = currentCommand;
            updateStatusText(lastCommand);
            publishCommand(lastCommand);
        }
    }
}

// --- Render Loop ---
renderer.setAnimationLoop(() => {
    // We check the left controller (handedness: 'left') for movement.
    const controller = renderer.xr.getController(0); // 0 is usually left, 1 is right
    handleController(controller);
    
    renderer.render(scene, camera);
});

// Handle window resizing
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
