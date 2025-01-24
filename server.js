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

async function fetchMarketCap(symbol) {
    try {
        const queryOptions = { modules: ['price', 'summaryDetail'] };
        const result = await yahooFinance.quoteSummary(symbol, queryOptions);
        return result.price.marketCap || result.summaryDetail.marketCap || null;
    } catch (err) {
        console.error(`Error fetching ${symbol}:`, err.message);
        return null;
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
                    const marketCap = await fetchMarketCap(stock.symbol);
                    if (marketCap) {
                        stock.marketCap = marketCap;
                        updatedCount++;
                        if (updatedCount % 10 === 0) {
                            console.log(`Updated ${updatedCount}/${totalStocks}: ${stock.symbol} - Market Cap: ${marketCap}`);
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

// Schedule daily updates
function scheduleUpdates() {
    // Log the next update time
    const now = new Date();
    const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const nextUpdate = new Date(est);
    nextUpdate.setHours(16, 0, 0, 0);
    if (est.getHours() >= 16) {
        nextUpdate.setDate(nextUpdate.getDate() + 1);
    }
    
    console.log('Next scheduled update:', nextUpdate.toLocaleString('en-US', { timeZone: 'America/New_York' }), 'EST');

    // Check every minute
    setInterval(async () => {
        if (isMarketCloseTime()) {
            console.log('Market closed, starting market cap update...');
            await updateMarketCaps();
            
            // Log next update time after completion
            const next = new Date();
            next.setDate(next.getDate() + 1);
            next.setHours(16, 0, 0, 0);
            console.log('Next scheduled update:', next.toLocaleString('en-US', { timeZone: 'America/New_York' }), 'EST');
        }
    }, 60000);
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
            
            console.log('Last update:', lastUpdate.toLocaleString());
            console.log('Current time:', now.toLocaleString());
            console.log('Has valid market cap data:', hasValidData);
            
            if (!hasValidData || now - lastUpdate > 24 * 60 * 60 * 1000) {
                console.log('Update needed - No valid data or data is over 24 hours old');
                needsUpdate = true;
            } else {
                console.log('Data is current and valid, no update needed');
            }
        } catch (err) {
            console.log('No existing data found or error reading file, update needed');
            needsUpdate = true;
        }

        if (needsUpdate) {
            console.log('Starting market cap update...');
            await updateMarketCaps();
        }
    } catch (err) {
        console.error('Failed to check last update:', err);
    }
}

// Start the update scheduler
scheduleUpdates();

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
