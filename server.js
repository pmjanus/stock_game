const express = require('express');
const path = require('path');
const app = express();
const port = 3200;

// Serve static files from the public directory
app.use(express.static('public'));

// Serve stocks.json
app.get('/stocks.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'stocks.json'));
});

// Serve index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/flash-quiz', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'flash-quiz.html'));
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 