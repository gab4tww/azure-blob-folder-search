

const express = require('express');
const { ContainerClient } = require('@azure/storage-blob');
const path = require('path');

const app = express();
const port = 3000;
// This is where to input the sasURL 
const sasUrl = 'https://azuretrialblob.blob.core.windows.net/marcom?sp=rl&st=2025-11-26T08:47:44Z&se=2026-12-16T17:02:44Z&spr=https&sv=2024-11-04&sr=c&sig=jaf2o43KIji5aBtRWI0XasyQo4VlqriTw%2Fljw5%2BV8Mc%3D';
const containerClient = new ContainerClient(sasUrl);

// Extract lang and optional date (flexible for D_______01_, strip extension)
function extractLangAndDate(name) {
  let cleanedName = name.replace(/\.[^/.]+$/, ''); // Strip extension
  cleanedName = cleanedName.replace(/^D[0-9a-zA-Z_]*_?/, ''); // Strip D_______ prefix
  const match = cleanedName.match(/([A-Z]{2}|01)(?:[\s_.-]*\(?(\d{4}-\d{2}(?:-\d{2})?|\d{2}-\d{4})\)?)?$/i);
  if (match) {
    let lang = match[1].toUpperCase();
    if (lang === '01') lang = 'EN';
    let date = match[2] || 'N/A';
    if (date.match(/\d{4}-\d{2}-\d{2}/)) date = date.slice(0, 7); // YYYY-MM
    return { lang, date };
  }
  if (name.includes('01')) {
    return { lang: 'EN', date: 'N/A' };
  }
  return null;
}

// Check if prefix exists
async function prefixExists(targetPrefix) {
  try {
    const iter = containerClient.listBlobsByHierarchy('/', { prefix: targetPrefix });
    const first = await iter[Symbol.asyncIterator]().next();
    return !first.done;
  } catch {
    return false;
  }
}

// Get languages/dates from prefix (.pdf only)
async function getPdfLanguages(targetPrefix) {
  const langMap = new Map();
  try {
    const iter = containerClient.listBlobsFlat({ prefix: targetPrefix });
    for await (const blob of iter) {
      const name = path.basename(blob.name);
      if (name.endsWith('.pdf')) {
        const extracted = extractLangAndDate(name);
        if (extracted) {
          if (!langMap.has(extracted.lang)) langMap.set(extracted.lang, new Set());
          langMap.get(extracted.lang).add(extracted.date);
        }
      }
    }
  } catch (error) {
    console.error('Error collecting langs:', error.message);
  }
  return langMap;
}

// Get languages from named subfolders
async function getNamedSubfolderLanguages(folderPrefix, folderName) {
  const langMap = new Map();
  try {
    const iter = containerClient.listBlobsByHierarchy('/', { prefix: folderPrefix });
    for await (const item of iter) {
      if (item.kind === 'prefix') {
        const subName = item.name.slice(0, -1).split('/').pop();
        if (subName.startsWith(folderName + '-')) {
          const extracted = extractLangAndDate(subName);
          if (extracted) {
            if (!langMap.has(extracted.lang)) langMap.set(extracted.lang, new Set());
            langMap.get(extracted.lang).add(extracted.date);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error getting named langs:', error.message);
  }
  return langMap;
}

// Main language logic
async function getFolderLanguages(folderPrefix, folderName) {
  let langMap = new Map();

  // LEGACY if exists
  const legacyPrefix = folderPrefix + 'LEGACY/';
  if (await prefixExists(legacyPrefix)) {
    langMap = await getNamedSubfolderLanguages(legacyPrefix, folderName);
    if (langMap.size === 0) {
      langMap = await getPdfLanguages(legacyPrefix);
    }
    if (langMap.size === 0) {
      langMap = await getPdfLanguages(folderPrefix); // Fallback
    }
    return langMapToObj(langMap);
  }

  // LAYER if exists
  const layerPrefix = folderPrefix + 'LAYER/';
  if (await prefixExists(layerPrefix)) {
    langMap = await getNamedSubfolderLanguages(layerPrefix, folderName);
    if (langMap.size === 0) {
      langMap = await getPdfLanguages(layerPrefix);
    }
    return langMapToObj(langMap);
  }

  // Fallback to named subfolders or .pdf in folder
  langMap = await getNamedSubfolderLanguages(folderPrefix, folderName);
  if (langMap.size === 0) {
    langMap = await getPdfLanguages(folderPrefix);
  }
  return langMapToObj(langMap);
}

function langMapToObj(langMap) {
  const langsObj = {};
  for (const [lang, dates] of langMap) {
    langsObj[lang] = dates.size > 0 ? Array.from(dates).sort().join(', ') : 'N/A';
  }
  return langsObj;
}

// Get max last modified from .pdf files
async function getFolderLastModified(prefix) {
  let maxDate = new Date(0);
  try {
    const iter = containerClient.listBlobsFlat({ prefix });
    for await (const blob of iter) {
      if (blob.name.endsWith('.pdf')) {
        const props = await containerClient.getBlobClient(blob.name).getProperties();
        if (props.lastModified > maxDate) maxDate = props.lastModified;
      }
    }
  } catch (error) {
    console.error('Error getting date:', error.message);
  }
  return maxDate > new Date(0) ? maxDate.toISOString().split('T')[0] + ' ' + maxDate.toISOString().split('T')[1].slice(0, 8) : 'N/A';
}

// Recursive search for matching folder
async function searchFolders(prefix = '', query, results) {
  try {
    const iter = containerClient.listBlobsByHierarchy('/', { prefix });
    for await (const item of iter) {
      if (item.kind === 'prefix') {
        const folderName = item.name.slice(0, -1).split('/').pop();
        if (folderName === query) { // Exact
          const languages = await getFolderLanguages(item.name, folderName);
          const lastModified = await getFolderLastModified(item.name);

          const downloadUrl = containerClient.url + '/' + item.name + (containerClient.sasToken || '');

          results.push({
            name: folderName,
            fullPath: '/' + item.name.slice(0, -1),
            lastModified,
            languages,
            downloadUrl
          });
          return; // Stop
        }
        await searchFolders(item.name, query, results);
      }
    }
  } catch (error) {
    console.error('Error searching:', error.message);
  }
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint
app.get('/search', async (req, res) => {
  const query = req.query.query || '';
  const results = [];
  await searchFolders('', query, results);
  res.json(results);
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});