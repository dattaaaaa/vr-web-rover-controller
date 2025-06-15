const express = require('express');
const path = require('path');
const app = express();

// Use the PORT environment variable if it's set (for Render), otherwise default to 3000
const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
