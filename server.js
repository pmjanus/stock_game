const https = require('https');
const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const yahooFinance = require('yahoo-finance2').default;
const fsSync = require('fs');

const app = express();
const port = process.argv[2] ? parseInt(process.argv[2], 10) : 3200;
const httpsPort = 443;

let isUpdatingMarketCaps = false;
let lastUpdateTime = null;

// SSL certificate and key from environment variables
let sslOptions;
try {
    sslOptions = {
        key: fsSync.readFileSync(process.env.SSL_KEY_PATH || ''),
        cert: fsSync.readFileSync(process.env.SSL_CERT_PATH || '')
    };
} catch (err) {
    console.error("Error loading SSL certificates. Falling back to HTTP only:", err.message);
    sslOptions = null;
}

// Add near the top of the file, after other const declarations
const args = process.argv.slice(2);
const forceRefresh = args.includes('--refresh');

// Add this constant near the top of the file
const UPDATE_INTERVAL = 20 * 60 * 1000; // 20 minutes in milliseconds

async function fetchMarketCap(symbol) {
    try {
        const queryOptions = { modules: ['price', 'summaryDetail'] };
        const result = await yahooFinance.quoteSummary(symbol, queryOptions);
        
        // Log the price data to see what we're getting
        console.log(`${symbol} price data:`, {
            marketCap: result.price.marketCap,
            regularMarketChange: result.price.regularMarketChange,
            regularMarketChangePercent: result.price.regularMarketChangePercent,
            regularMarketPrice: result.price.regularMarketPrice
        });

        // The regularMarketChangePercent from Yahoo is already in percentage form
        // So if it returns 2.5, it means 2.5%, we don't need to multiply by 100
        return {
            marketCap: result.price.marketCap || result.summaryDetail.marketCap || null,
            regularMarketChangePercent: result.price.regularMarketChangePercent || null,
            regularMarketChange: result.price.regularMarketChange || null,
            regularMarketPrice: result.price.regularMarketPrice || null
        };
    } catch (err) {
        console.error(`Error fetching ${symbol}:`, err.message);
        return {
            marketCap: null,
            regularMarketChangePercent: null,
            regularMarketChange: null,
            regularMarketPrice: null
        };
    }
}

async function updateMarketCaps() {
    if (isUpdatingMarketCaps) return;
    try {
        isUpdatingMarketCaps = true;
        console.log('Starting market cap update...');
        
        const stocksData = JSON.parse(
            await fs.readFile(path.join(__dirname, 'stocks.json'), 'utf8')
        );

        let updatedCount = 0;
        const totalStocks = stocksData.length;

        console.log('Initial check - First stock:', {
            symbol: stocksData[0].symbol,
            currentMarketCap: stocksData[0].marketCap
        });

        // Update in batches of 10 to avoid rate limiting
        for (let i = 0; i < stocksData.length; i += 10) {
            const batch = stocksData.slice(i, i + 10);
            const updates = await Promise.all(
                batch.map(async (stock) => {
                    const data = await fetchMarketCap(stock.symbol);
                    if (data.marketCap) {
                        stock.marketCap = data.marketCap;
                        stock.priceChange = data.regularMarketChange;
                        stock.priceChangePercent = data.regularMarketChangePercent;
                        updatedCount++;
                        if (updatedCount % 10 === 0) {
                            console.log(`Updated ${updatedCount}/${totalStocks}: ${stock.symbol} - Market Cap: ${data.marketCap}`);
                        }
                    }
                    return stock;
                })
            );
            
            // Add delay between batches
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('Final check - First stock:', {
            symbol: stocksData[0].symbol,
            newMarketCap: stocksData[0].marketCap
        });

        const hasMarketCaps = stocksData.some(stock => stock.marketCap > 0);
        if (!hasMarketCaps) {
            throw new Error('No valid market cap data received from Yahoo Finance');
        }

        await fs.writeFile(
            path.join(__dirname, 'stocks.json'),
            JSON.stringify(stocksData, null, 2)
        );

        lastUpdateTime = new Date().toISOString();
        console.log(`Market cap update completed. Updated ${updatedCount} stocks.`);
    } catch (err) {
        console.error('Failed to update market caps:', err);
        // Force an immediate retry if we got no market cap data
        if (err.message === 'No valid market cap data received from Yahoo Finance') {
            console.log('Scheduling retry in 5 minutes...');
            setTimeout(updateMarketCaps, 5 * 60 * 1000);
        }
    } finally {
        isUpdatingMarketCaps = false;
    }
}

// Function to check if it's market close time (4 PM EST)
function isMarketCloseTime() {
    const now = new Date();
    const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return est.getHours() === 16 && est.getMinutes() === 0;
}

// Move isMarketOpen outside of scheduleUpdates
function isMarketOpen() {
    const now = new Date();
    const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = est.getDay();
    const hour = est.getHours();
    const minute = est.getMinutes();
    
    // Market is closed on weekends (0 = Sunday, 6 = Saturday)
    if (day === 0 || day === 6) return false;
    
    // Market is open from 9:30 AM to 4:00 PM EST
    if (hour < 9 || hour > 16) return false;
    if (hour === 9 && minute < 30) return false;
    if (hour === 16 && minute > 0) return false;
    
    return true;
}

// Schedule daily updates
function scheduleUpdates() {
    // Initial log
    console.log('Starting price update scheduler...');

    // Schedule regular updates
    setInterval(async () => {
        if (isMarketOpen()) {
            console.log('Market is open, updating price data...');
            await updateMarketCaps();
            
            // Log next update time
            const nextUpdate = new Date(Date.now() + UPDATE_INTERVAL);
            console.log('Next price update scheduled for:', 
                nextUpdate.toLocaleString('en-US', { timeZone: 'America/New_York' }), 'EST');
        } else {
            console.log('Market is closed, skipping price update');
        }
    }, UPDATE_INTERVAL);

    // Also keep the market close update for end-of-day data
    setInterval(async () => {
        if (isMarketCloseTime()) {
            console.log('Market closed, running end-of-day update...');
            await updateMarketCaps();
            
            // Log next end-of-day update
            const next = new Date();
            next.setDate(next.getDate() + 1);
            next.setHours(16, 0, 0, 0);
            console.log('Next end-of-day update:', 
                next.toLocaleString('en-US', { timeZone: 'America/New_York' }), 'EST');
        }
    }, 60000); // Check every minute for market close
}

async function checkLastUpdate() {
    try {
        console.log('Checking if market cap data needs updating...');
        
        let needsUpdate = false;
        try {
            const stats = await fs.stat(path.join(__dirname, 'stocks.json'));
            const stocksData = JSON.parse(
                await fs.readFile(path.join(__dirname, 'stocks.json'), 'utf8')
            );
            
            const lastUpdate = new Date(stats.mtime);
            const now = new Date();
            const hasValidData = stocksData.some(stock => stock.marketCap > 0);
            const timeSinceLastUpdate = now - lastUpdate;
            
            console.log('Last update:', lastUpdate.toLocaleString());
            console.log('Current time:', now.toLocaleString());
            console.log('Has valid market cap data:', hasValidData);
            
            // Update if forced, no valid data, or more than 20 minutes since last update
            if (forceRefresh || !hasValidData || timeSinceLastUpdate > UPDATE_INTERVAL) {
                console.log(forceRefresh ? 'Force refresh requested' : 
                    'Update needed - No valid data or data is over 20 minutes old');
                needsUpdate = true;
            } else {
                console.log('Data is current and valid, no update needed');
            }
        } catch (err) {
            console.log('No existing data found or error reading file, update needed');
            needsUpdate = true;
        }

        if (needsUpdate && isMarketOpen()) {
            console.log('Starting market cap update...');
            await updateMarketCaps();
        }
    } catch (err) {
        console.error('Failed to check last update:', err);
    }
}

// Start the update scheduler
scheduleUpdates();

// Serve favicon
app.get('/favicon.ico', (req, res) => {
    res.status(204).end(); // No content response for favicon
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve stocks.json
app.get('/stocks.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); // Prevent caching
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(path.join(__dirname, 'stocks.json'));
});

// Add error handling for stocks.json
app.use((err, req, res, next) => {
    if (err.code === 'ENOENT' && err.path.includes('stocks.json')) {
        console.error('stocks.json not found');
        return res.status(404).json({ error: 'Stock data not available' });
    }
    next(err);
});

// Serve index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/flash-quiz', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'flash-quiz.html'));
});

app.get('/sp500-explorer', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sp500-explorer.html'));
});

app.get('/market-cap-status', (req, res) => {
    res.json({
        isUpdating: isUpdatingMarketCaps,
        lastUpdate: lastUpdateTime,
        hasValidData: false // We'll update this
    });
});

async function getMarketCapStatus() {
    try {
        const stocksData = JSON.parse(
            await fs.readFile(path.join(__dirname, 'stocks.json'), 'utf8')
        );
        const hasValidData = stocksData.some(stock => stock.marketCap > 0);
        return {
            isUpdating: isUpdatingMarketCaps,
            lastUpdate: lastUpdateTime,
            hasValidData
        };
    } catch (err) {
        return {
            isUpdating: isUpdatingMarketCaps,
            lastUpdate: lastUpdateTime,
            hasValidData: false
        };
    }
}

app.get('/market-cap-status', async (req, res) => {
    const status = await getMarketCapStatus();
    res.json(status);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).send('Internal Server Error');
});

// Handle 404s
app.use((req, res) => {
    res.status(404).send('Not Found');
});

// Start the HTTP server
http.createServer(app).listen(port, async () => {
    console.log(`HTTP server running at http://localhost:${port}`);
    console.log('Checking market cap data on startup...');
    await checkLastUpdate();
    console.log('Starting update scheduler...');
    scheduleUpdates();
});

// Start the HTTPS server if SSL options are available
if (sslOptions && sslOptions.key && sslOptions.cert) {
    https.createServer(sslOptions, app).listen(httpsPort, () => {
        console.log(`HTTPS server running at https://localhost:${httpsPort}`);
    });
} else {
    console.log("SSL certificates not configured. HTTPS server is disabled.");
}
