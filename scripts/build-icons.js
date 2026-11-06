import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The list of icons needed for the application
const ICONS = [
    'edit', 'delete', 'add', 'search', 'settings',
    'light_mode', 'dark_mode', 'chevron_left', 'chevron_right', 'keyboard_arrow_right',
    'open_in_new', 'refresh', 'visibility', 'visibility_off', 'sort_by_alpha',
    'check', 'close', 'menu', 'content_copy', 'view_list',
    'keyboard_arrow_down', 'keyboard_arrow_up', 'more_horiz', 'more_vert',
    'open_with', 'print', 'unfold_more', 'unfold_less', 'arrow_back',
    'grid_view', 'description', 'draw', 'schema', 'folder', 'sync', 'help', 'settings',
    'key', 'lock', 'drag_indicator', 'notifications'
];

// Deduplicate and encode icons
const textParam = encodeURIComponent(Array.from(new Set(ICONS)).join(''));

const CSS_URL = `https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,300,0,0&text=${textParam}`;
const OUTPUT_FILE = path.join(__dirname, '..', 'frontend', 'vendor', 'icons.woff2');

console.log(`Fetching CSS from: ${CSS_URL}`);

https.get(CSS_URL, {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    }
}, (res) => {
    if (res.statusCode !== 200) {
        console.error(`Error: Failed to fetch CSS. Status Code: ${res.statusCode}`);
        res.resume();
        return;
    }

    let cssData = '';
    res.on('data', (chunk) => { cssData += chunk; });
    res.on('end', () => {
        const urlMatch = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)\s*format\('woff2'\)/.exec(cssData);
        
        if (!urlMatch?.[1]) {
            console.error('Error: Could not extract woff2 URL from Google Fonts CSS.');
            console.error('CSS Response:', cssData);
            return;
        }

        const woff2Url = urlMatch[1];
        console.log(`Found subset WOFF2 URL: ${woff2Url}`);
        console.log(`Downloading font to ${OUTPUT_FILE}...`);

        https.get(woff2Url, (fontRes) => {
            if (fontRes.statusCode !== 200) {
                console.error(`Error: Failed to fetch font. Status Code: ${fontRes.statusCode}`);
                fontRes.resume();
                return;
            }

            const fileStream = fs.createWriteStream(OUTPUT_FILE);
            fontRes.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                console.log('Font successfully downloaded!');
            });
        }).on('error', (err) => {
            console.error(`Error downloading font: ${err.message}`);
        });
    });
}).on('error', (err) => {
    console.error(`Error fetching CSS: ${err.message}`);
});
