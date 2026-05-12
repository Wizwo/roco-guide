#!/usr/bin/env node
/**
 * 洛克王国 bilibili wiki 宠物数据爬虫
 * 爬取 https://wiki.biligame.com/rocom/ 所有精灵页面
 * 输出: data/pets.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const WIKI_BASE = 'wiki.biligame.com';
const BASE_PATH = '/rocom';
const OUT_FILE = path.join(__dirname, '..', 'data', 'pets.json');

// Promise-based HTTP GET
function httpGet(rawPath) {
  return new Promise((resolve, reject) => {
    // rawPath may contain Chinese characters and special chars that need encoding
    const url = new URL(rawPath, `https://${WIKI_BASE}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; roco-guide-bot/1.0; +https://github.com/Wizwo/roco-guide)',
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    };
    const req = https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Handle redirects
        httpGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${path}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error for ${path}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout for ${path}`)); });
  });
}

// Parse {{精灵信息}} wikitext template into an object
function parsePetTemplate(wikitext) {
  const pet = {};
  const lines = wikitext.split('\n');
  let inTemplate = false;
  let braceDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track template braces
    if (trimmed.startsWith('{{精灵信息')) {
      inTemplate = true;
      braceDepth = (trimmed.match(/{{/g) || []).length - (trimmed.match(/}}/g) || []).length;
      // Handle single-line template
      if (trimmed.includes('}}')) {
        inTemplate = false;
      }
      // Parse the template content (after {{精灵信息|)
      const content = trimmed.replace(/^\{\{精灵信息\|/, '').replace(/\}\}$/, '');
      parseTemplateLine(content, pet);
    } else if (inTemplate) {
      braceDepth += (trimmed.match(/{{/g) || []).length - (trimmed.match(/}}/g) || []).length;
      if (braceDepth <= 0) {
        inTemplate = false;
        continue;
      }
      parseTemplateLine(trimmed, pet);
    }
  }
  return pet;
}

function parseTemplateLine(line, pet) {
  // Split by | but not inside [[ ]]
  const parts = line.split('|').filter(p => p.includes('='));
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim()
      .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')  // [[text|alias]] -> text
      .replace(/\[\[([^\]]+)\]\]/g, '$1')              // [[text]] -> text
      .replace(/<ref[^>]*>.*?<\/ref>/gi, '')           // remove <ref> tags
      .replace(/<noinclude>.*?<\/noinclude>/gi, '')   // remove noinclude
      .replace(/<includeonly>.*?<\/includeonly>/gi, '') // remove includeonly
      .replace(/'''/g, '')                             // remove bold markup
      .replace(/''/g, '')                             // remove italic markup
      .trim();
    if (key && value) {
      pet[key] = value;
    }
  }
}

// Get all pet names from category
async function getAllPetNames() {
  console.log('Fetching pet list from bilibili wiki...');
  const pets = [];
  let cmcontinue = null;

  do {
    let path = `${BASE_PATH}/api.php?action=query&list=categorymembers&cmtitle=分类:精灵&cmlimit=500&format=json`;
    if (cmcontinue) {
      path += `&cmcontinue=${encodeURIComponent(cmcontinue)}`;
    }

    const data = await httpGet(path);
    const members = data.query?.categorymembers || [];
    for (const m of members) {
      // Skip alternate/seasonal forms (names with （）)
      if (!m.title.includes('（') && !m.title.includes('(')) {
        pets.push(m.title);
      }
    }
    cmcontinue = data.continue?.cmcontinue || null;
    console.log(`  Got ${pets.length} pets so far...`);
  } while (cmcontinue);

  console.log(`Total unique pets: ${pets.length}`);
  return [...new Set(pets)];
}

// Fetch wikitext for a single pet page
async function getPetWikitext(title) {
  const encoded = encodeURIComponent(title);
  const data = await httpGet(`${BASE_PATH}/api.php?action=parse&page=${encoded}&prop=wikitext&format=json`);
  return data.parse?.wikitext?.['*'] || '';
}

// Main scrape function
async function scrapePets() {
  console.log('=== 洛克王国宠物数据爬虫 ===\n');
  const startTime = Date.now();

  // Get pet list
  const petNames = await getAllPetNames();

  // Fetch details for each pet (with batching for speed)
  console.log('\nFetching pet details...');
  const pets = {};
  const errors = [];
  const batchSize = 3;   // 小批次避免触发限流
  const delay = ms => new Promise(r => setTimeout(r, ms));

  for (let i = 0; i < petNames.length; i += batchSize) {
    const batch = petNames.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (name) => {
        try {
          const wikitext = await getPetWikitext(name);
          const pet = parsePetTemplate(wikitext);
          // Use a slug as key
          const slug = name.toLowerCase().replace(/\s+/g, '-');
          pets[slug] = {
            name,
            slug,
            wikiTitle: name,
            ...pet
          };
        } catch (e) {
          errors.push({ name, error: e.message });
        }
      })
    );

    const done = Math.min(i + batchSize, petNames.length);
    process.stdout.write(`\r  Progress: ${done}/${petNames.length} (${((done/petNames.length)*100).toFixed(0)}%)`);
    await delay(300);   // 批次间延迟，降低限流风险
  }
  console.log(`\n  Done! ${Object.keys(pets).length} pets scraped, ${errors.length} errors`);

  if (errors.length > 0 && errors.length <= 10) {
    console.log('Errors:', errors.map(e => `${e.name}: ${e.error}`).join(', '));
  }

  // Write output
  const output = {
    updatedAt: new Date().toISOString(),
    totalCount: Object.keys(pets).length,
    pets
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nOutput: ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB)`);
  console.log(`Time: ${elapsed}s`);

  // Summary stats
  const attrCount = new Set(Object.values(pets).map(p => p['主属性']).filter(Boolean)).size;
  console.log(`\nStats: ${Object.keys(pets).length} pets, ${attrCount} different attributes`);
}

scrapePets().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
