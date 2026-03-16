const fs = require("fs");  
const axios = require("axios");  
const cheerio = require("cheerio");  
const RSS = require("rss");  
  
const baseURL = "https://www.yahoo.com";  
const targetURL = "https://www.yahoo.com/news/world/";  
const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";  
const MAX_ITEMS = 1000;  
  
fs.mkdirSync("./feeds", { recursive: true });  
  
// ===== DATE PARSING =====  
function parseItemDate(raw) {  
  if (!raw || !raw.trim()) return new Date();  
  const trimmed = raw.trim();  
  
  const relMatch = trimmed.match(/^(\d+)\s+(minute|hour|day)s?\s+ago$/i);  
  if (relMatch) {  
    const n    = parseInt(relMatch[1], 10);  
    const unit = relMatch[2].toLowerCase();  
    const ms   = unit === "minute" ? n * 60_000  
               : unit === "hour"   ? n * 3_600_000  
               :                     n * 86_400_000;  
    return new Date(Date.now() - ms);  
  }  
  
  const d = new Date(trimmed);  
  if (!isNaN(d.getTime())) return d;  
  
  console.warn(`⚠️  Could not parse date: "${trimmed}" — using now()`);  
  return new Date();  
}  
  
// ===== FLARESOLVERR =====  
async function fetchWithFlareSolverr(url) {  
  console.log(`Fetching ${url} via FlareSolverr...`);  
  const response = await axios.post(  
    `${flareSolverrURL}/v1`,  
    { cmd: "request.get", url, maxTimeout: 60000 },  
    { headers: { "Content-Type": "application/json" }, timeout: 65000 }  
  );  
  if (response.data?.solution) {  
    console.log("✅ FlareSolverr successfully bypassed protection");  
    return response.data.solution.response;  
  }  
  throw new Error("FlareSolverr did not return a solution");  
}  
  
// ===== LOAD EXISTING FEED =====  
function loadExistingItems(seen) {  
  const feedPath = "./feeds/feed.xml";  
  if (!fs.existsSync(feedPath)) return [];  
  
  try {  
    const existingXml = fs.readFileSync(feedPath, "utf8");  
    const $existing   = cheerio.load(existingXml, { xmlMode: true });  
    const existing    = [];  
  
    $existing("item").each((_, el) => {  
      const $el  = $existing(el);  
      // Cheerio xmlMode puts <link> text between CDATA siblings — use guid as fallback  
      const link = $el.find("link").text().trim()  
                || $el.find("guid").text().trim();  
      if (!link || seen.has(link)) return;  
      seen.add(link);  
  
      existing.push({  
        title:       $el.find("title").text().trim(),  
        link,  
        description: $el.find("description").text().trim(),  
        author:      $el.find("author").text().trim() || undefined,  
        date:        new Date($el.find("pubDate").text().trim()) || new Date(),  
      });  
    });  
  
    console.log(`📂 Loaded ${existing.length} existing items from feed`);  
    return existing;  
  } catch (err) {  
    console.warn(`⚠️  Could not load existing feed: ${err.message}`);  
    return [];  
  }  
}  
  
// ===== MAIN =====  
async function generateRSS() {  
  try {  
    const htmlContent = await fetchWithFlareSolverr(targetURL);  
    const $ = cheerio.load(htmlContent);  
    const freshItems = [];  
    const seen       = new Set();  
  
    // ── Load existing items first so seen is pre-populated ──  
    const existingItems = loadExistingItems(seen);  
  
    // ── Helper: extract one article from a container element ──  
    function extractItem(el) {  
      const $el = $(el);  
  
      const $anchor = $el.find("h3 a").first();  
      const title   = $anchor.text().trim()  
                   || (() => {  
                        try {  
                          const yga = $anchor.attr("data-yga") || "";  
                          const m   = yga.match(/"yLinkText":"([^"]+)"/);  
                          return m ? m[1] : "";  
                        } catch { return ""; }  
                      })();  
      if (!title) return null;  
  
      const href = $anchor.attr("href");  
      if (!href)  return null;  
      const link = href.startsWith("http") ? href : baseURL + href;  
      if (seen.has(link)) return null;   // skip duplicates (new or old)  
      seen.add(link);  
  
      const $imgDesktop = $el.find("img.sm\\:block").first();  
      const $imgMobile  = $el.find("img.size-\\[130px\\]").first();  
      const thumbnail   = ($imgDesktop.attr("src") || $imgMobile.attr("src") || "").trim();  
  
      const description = $el.find("p.hidden").first().text().trim();  
      const source      = $el.find("span.truncate.whitespace-nowrap").first().text().trim();  
      const rawDate     = $el.find("span.label-m-regular.text-tertiary").first().text().trim();  
  
      return { title, link, thumbnail, description, source, date: parseItemDate(rawDate) };  
    }  
  
    // ── 1. Featured / "Need to Know" hero cards ──  
    $("#hubs-ntk article").each((_, el) => {  
      const $article = $(el);  
      const $anchor  = $article.find("a[href*='/news/articles/']").first();  
      const title    = $article.find("h3").first().text().trim();  
      const href     = $anchor.attr("href");  
      if (!title || !href) return;  
  
      const link = href.startsWith("http") ? href : baseURL + href;  
      if (seen.has(link)) return;  
      seen.add(link);  
  
      const thumbnail = $article.find("img").first().attr("src") || "";  
      const source    = $article.find("span.truncate.whitespace-nowrap").first().text().trim();  
  
      freshItems.push({ title, link, thumbnail, description: "", source, date: new Date() });  
    });  
  
    // ── 2. Article stream ──  
    $("li.list-none").each((_, el) => {  
      const item = extractItem(el);  
      if (item) freshItems.push(item);  
    });  
  
    console.log(`🆕 Found ${freshItems.length} new articles`);  
  
    // ── Merge: new items at the front, old items behind ──  
    // Then slice to MAX_ITEMS — oldest fall off the end (recycle)  
    const allItems = [...freshItems, ...existingItems].slice(0, MAX_ITEMS);  
    console.log(`📦 Total items after merge + recycle: ${allItems.length} / ${MAX_ITEMS}`);  
  
    if (allItems.length === 0) {  
      allItems.push({  
        title:       "No articles found yet",  
        link:        targetURL,  
        description: "RSS feed could not scrape any articles.",  
        source:      "",  
        thumbnail:   "",  
        date:        new Date(),  
      });  
    }  
  
    // ── Build RSS ──  
    const feed = new RSS({  
      title:       "Yahoo News – World",  
      description: "Latest world news from Yahoo News",  
      feed_url:    targetURL,  
      site_url:    targetURL,  
      language:    "en",  
      pubDate:     new Date().toUTCString(),  
    });  
  
    allItems.forEach(item => {  
      const imgTag = item.thumbnail  
        ? `<p><img src="${item.thumbnail}" alt="" /></p>`  
        : "";  
  
      feed.item({  
        title:       item.title,  
        url:         item.link,  
        description: imgTag + (item.description || (item.source ? `Source: ${item.source}` : "")),  
        author:      item.source || undefined,  
        date:        item.date,  
      });  
    });  
  
    const xml = feed.xml({ indent: true });  
    fs.writeFileSync("./feeds/feed.xml", xml);  
    console.log(`✅ RSS written with ${allItems.length} items → ./feeds/feed.xml`);  
  
  } catch (err) {  
    console.error("❌ Error generating RSS:", err.message);  
  
    // On error, preserve whatever is already in the file — don't overwrite with a placeholder  
    if (!fs.existsSync("./feeds/feed.xml")) {  
      const feed = new RSS({  
        title:       "Yahoo News – World (error fallback)",  
        description: "RSS feed could not scrape, showing placeholder",  
        feed_url:    targetURL,  
        site_url:    baseURL,  
        language:    "en",  
        pubDate:     new Date().toUTCString(),  
      });  
      feed.item({  
        title:       "Feed generation failed",  
        url:         targetURL,  
        description: "An error occurred during scraping.",  
        date:        new Date(),  
      });  
      fs.writeFileSync("./feeds/feed.xml", feed.xml({ indent: true }));  
    } else {  
      console.log("⚠️  Keeping existing feed.xml intact after error.");  
    }  
  }  
}  
  
generateRSS();