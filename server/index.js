const path = require("path")
const dotenv = require("dotenv")
const fs = require("fs")

dotenv.config({ path: path.resolve(__dirname, "./.env") })

const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const cors = require("cors")
const { google } = require("googleapis")
const axios = require("axios")
const cheerio = require("cheerio")
const puppeteer = require("puppeteer")
require("puppeteer").defaultArgs({
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
}) // Global default args if possible? No.
const sharp = require("sharp")

// --- AUTHENTICATION SETUP ---
let googleAuthOptions = {}

if (process.env.GOOGLE_CREDENTIALS_BASE64) {
  try {
    const decoded = Buffer.from(
      process.env.GOOGLE_CREDENTIALS_BASE64,
      "base64"
    ).toString("utf-8")
    const credentials = JSON.parse(decoded)
    googleAuthOptions = { credentials }
    console.log("✅ Loaded Google credentials from environment variable.")
  } catch (err) {
    console.error("❌ Failed to parse GOOGLE_CREDENTIALS_BASE64:", err.message)
    process.exit(1)
  }
} else if (process.env.GOOGLE_CREDENTIALS) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS)
    googleAuthOptions = { credentials }
    console.log("✅ Loaded Google credentials from GOOGLE_CREDENTIALS env var.")
  } catch (err) {
    console.error("❌ Failed to parse GOOGLE_CREDENTIALS:", err.message)
    process.exit(1)
  }
} else if (
  process.env.CREDENTIALS_PATH ||
  fs.existsSync(path.resolve(__dirname, "credentials.json"))
) {
  // Fallback for local dev if file exists
  const credPath = path.resolve(
    __dirname,
    process.env.CREDENTIALS_PATH || "credentials.json"
  )
  googleAuthOptions = { keyFile: credPath }
  console.log(`Using credentials file at ${credPath}`)
} else {
  console.error("❌ FATAL: No Google credentials found (Env or File).")
  process.exit(1)
}

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(".")) // Serve static files (e.g., screenshots)

// --- Socket.io Setup ---
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins
    methods: ["GET", "POST"],
  },
})

// --- Helper for Google Sheets Auth ---
// We'll use a singleton or create it on demand.
// Note: googleapis `google.auth.GoogleAuth` is what we need.
const getAuthClient = () => {
  return new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    ...googleAuthOptions,
  })
}

const getSheetsApi = async () => {
  const auth = getAuthClient()
  const client = await auth.getClient()
  return google.sheets({ version: "v4", auth: client })
}

// --- Sheet IDs for API Endpoints & Injector ---
const MAIN_SHEET_ID = process.env.MAIN_SHEET_ID
const ADA_PRO_ID = process.env.ADA_PRO_ID
const ADA_DUPLICATE_SHEET_ID = process.env.ADA_DUPLICATE_SHEET_ID
const BULK_INJECT_SHEET_ID = process.env.BULK_INJECT_SHEET_ID
const ACCESSIBILITY_STATEMENT_SHEET_ID =
  process.env.ACCESSIBILITY_STATEMENT_SHEET_ID

// --- UserWay Account ID (for /api/scan and injector) ---
const USERWAY_ACCOUNT_ID = process.env.USERWAY_ACCOUNT_ID // This is the Pro ID, e.g., '062WMb6Yf6'

if (!USERWAY_ACCOUNT_ID) console.warn("⚠️ USERWAY_ACCOUNT_ID not found in .env")
if (!BULK_INJECT_SHEET_ID)
  console.warn("⚠️ BULK_INJECT_SHEET_ID not found in .env")

// --- UserWay Scripts ---
const ELEMENTOR_SCRIPT = `<script src="https://cdn.userway.org/widget.js" data-account="${USERWAY_ACCOUNT_ID}"></script>`
const WP_BAKERY_SNIPPET = `
(function(d){
var s = d.createElement("script");
/* uncomment the following line to override default position*/
/* s.setAttribute("data-position", 3);*/
/* uncomment the following line to override default size (values: small, large)*/
/* s.setAttribute("data-size", "small");*/
/* uncomment the following line to override default language (e.g., fr, de, es, he, nl, etc.)*/
/* s.setAttribute("data-language", "language");*/
/* uncomment the following line to override color set via widget (e.g., #053f67)*/
/* s.setAttribute("data-color", "#053e67");*/
/* uncomment the following line to override type set via widget (1=person, 2=chair, 3=eye, 4=text)*/
/* s.setAttribute("data-type", "1");*/
/* s.setAttribute("data-statement_text:", "Our Accessibility Statement");*/
/* s.setAttribute("data-statement_url", "http://www.example.com/accessibility")";*/
/* uncomment the following line to override support on mobile devices*/
/* s.setAttribute("data-mobile", true);*/
/* uncomment the following line to set custom trigger action for accessibility menu*/
/* s.setAttribute("data-trigger", "triggerId")*/
/* uncomment the following line to override widget's z-index property*/
/* s.setAttribute("data-z-index", 10001);*/
/* uncomment the following line to enable Live site translations (e.g., fr, de, es, he, nl, etc.)*/
/* s.setAttribute("data-site-language", "null");*/
s.setAttribute("data-widget_layout", "full")
s.setAttribute("data-account", "${USERWAY_ACCOUNT_ID}");
s.setAttribute("src", "https://cdn.userway.org/widget.js");
(d.body || d.head).appendChild(s);
})(document)
`

function rgbToHex(rgb) {
  if (!rgb || typeof rgb !== "string") return rgb

  rgb = rgb.trim()

  // Already hex

  if (rgb.startsWith("#")) return rgb.toUpperCase()

  // Transparent or named color

  if (rgb === "transparent") return "transparent"

  // Match rgb/rgba forms including percentage values

  const match = rgb.match(
    /rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)(?:\s*,\s*([\d.]+))?\s*\)/
  )

  if (!match) return rgb

  function normalize(v) {
    if (v.endsWith("%")) {
      return Math.round((parseFloat(v) / 100) * 255)
    }

    return Math.min(255, Math.max(0, parseFloat(v)))
  }

  const r = normalize(match[1])

  const g = normalize(match[2])

  const b = normalize(match[3])

  const a = match[4] !== undefined ? parseFloat(match[4]) : 1

  const hex = `#${r.toString(16).padStart(2, "0")}${g

    .toString(16)

    .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase()

  if (a < 1)
    return `${hex}${Math.round(a * 255)
      .toString(16)
      .padStart(2, "0")}`.toUpperCase()

  return hex
}

// --- Global state for running jobs ---
const stopFlags = {}
const interactiveSessions = {} // Stores { browser, sitesRemaining }

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id)

  // Helper to log to both server console and client UI via socket
  const logToClient = (message, level = "info") => {
    const logData = { message, level }
    console.log(`[${level}] ${message}`)
    // Emit to the specific user who started the job
    socket.emit("bulk-inject-log", logData)
  }

  // --- START: Job Cleanup ---
  const cleanupSession = async (sid) => {
    logToClient("Cleaning up session...")
    delete stopFlags[sid]
    const session = interactiveSessions[sid]
    if (session) {
      try {
        if (session.browser) {
          await session.browser.close()
        }
      } catch (e) {
        logToClient("Browser already closed.", "error")
      }
      delete interactiveSessions[sid]
    }
  }

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id)
    cleanupSession(socket.id) // Clean up on disconnect
  })

  socket.on("stop-bulk-inject", () => {
    logToClient("STOP signal received for bulk inject.")
    stopFlags[socket.id] = true
  })

  socket.on("stop-interactive-verify", async () => {
    logToClient("STOP signal received for interactive verify.")
    stopFlags[socket.id] = true
    await cleanupSession(socket.id)
    logToClient("Process stopped by user.")
  })
  // --- END: Job Cleanup ---

  socket.on("stop-color-scan", () => {
    logToClient("STOP signal received for color scan.")
    stopFlags[socket.id] = true
    logToClient("Process stopped by user.") // This triggers the UI reset
  })

  socket.on("stop-accessibility-check", async () => {
    logToClient("STOP signal received for running job.")
    stopFlags[socket.id] = true
    await cleanupSession(socket.id)
    logToClient("Process stopped by user.")
  })

  // --- START: BULK INJECT LOGIC ---
  socket.on("start-bulk-inject", async (options) => {
    stopFlags[socket.id] = false

    const config = {
      sheetId: BULK_INJECT_SHEET_ID,
      concurrency: 1,
      headless: true,
      credentials: CREDENTIALS_PATH,
      ...options,
    }
    const HEADLESS =
      config.headless === "false"
        ? false
        : config.headless === "true"
        ? true
        : config.headless

    logToClient(
      `Bulk inject started. Concurrency: ${config.concurrency}, Headless: ${HEADLESS}`
    )

    if (!config.sheetId) {
      logToClient(
        "ERROR: sheetId is not set. Please update .env or send from client.",
        "error"
      )
      return
    }
    if (!fs.existsSync(config.credentials)) {
      logToClient(
        `ERROR: Credentials file not found at ${config.credentials}.`,
        "error"
      )
      return
    }

    try {
      const sites = await getSitesFromSheet(
        config.sheetId,
        config.range || "Sheet1!A1:E", // Default range
        config.credentials,
        logToClient
      )

      logToClient("Launching Puppeteer browser for bulk inject...")
      const browser = await puppeteer.launch({
        headless: HEADLESS,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      })

      const results = []
      const queue = sites.slice()
      let index = 0

      logToClient(`Starting worker pool with ${config.concurrency} workers...`)
      const workers = new Array(config.concurrency).fill(null).map(async () => {
        while (queue.length) {
          if (stopFlags[socket.id]) {
            logToClient("Worker stopping due to user request.")
            break
          }
          const site = queue.shift()

          if (!site.url || !site.username || !site.password) {
            logToClient(
              `[${
                index + 1
              }] Skipping row: Data is incomplete (URL, user, or pass is missing).`
            )
            index += 1
            continue
          }
          index += 1
          const result = await processSite(
            browser,
            site,
            index,
            logToClient,
            socket.id
          )
          results.push(result)
          await sleep(1000)
        }
      })

      await Promise.all(workers)
      await browser.close()

      const resultsFilename = `results-${Date.now()}.json`
      fs.writeFileSync(resultsFilename, JSON.stringify(results, null, 2))

      if (stopFlags[socket.id]) {
        logToClient(
          `Process stopped by user. Results so far saved to server as ${resultsFilename}`
        )
      } else {
        logToClient(
          `All done. Results saved to server as ${resultsFilename}`,
          "success"
        )
      }
    } catch (err) {
      console.error("Orchestrator error:", err.message)
      logToClient("FATAL ERROR: " + err.message, "error")
    }
  })
  // --- END: BULK INJECT LOGIC ---

  // --- START: NEW INTERACTIVE VERIFY LOGIC ---
  socket.on("start-interactive-verify", async (options) => {
    stopFlags[socket.id] = false
    logToClient("Starting Interactive Verify & Inject...")

    const config = {
      sheetId: BULK_INJECT_SHEET_ID,
      range: "Sheet1!A1:E", // Make sure this range includes URL and credentials
      headless: true,
      credentials: CREDENTIALS_PATH,
      ...options,
    }
    const HEADLESS =
      config.headless === "false"
        ? false
        : config.headless === "true"
        ? true
        : config.headless

    try {
      const sites = await getSitesFromSheet(
        config.sheetId,
        config.range,
        config.credentials,
        logToClient
      )

      logToClient("Launching persistent Puppeteer browser for session...")
      const browser = await puppeteer.launch({
        headless: HEADLESS,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      })

      interactiveSessions[socket.id] = { browser, sitesRemaining: sites }
      // Start the recursive-style processing loop (without parameters)
      await runInteractiveVerify(socket)
    } catch (err) {
      logToClient(`FATAL ERROR: ${err.message}`, "error")
      await cleanupSession(socket.id)
    }
  })

  socket.on("user-confirmed-install", async ({ site }) => {
    const session = interactiveSessions[socket.id]
    if (!session || stopFlags[socket.id]) {
      logToClient("Session expired or stopped. Aborting install.", "error")
      return
    }

    try {
      logToClient(`User confirmed. Injecting script into ${site.url}...`)
      // We pass the persistent browser from the session
      await processSite(
        session.browser,
        site,
        "Interactive",
        logToClient,
        socket.id
      )
      logToClient("Injection complete.", "success")
    } catch (e) {
      logToClient(`Injection failed: ${e.message}`, "error")
    }

    // Continue the loop with the remaining sites
    logToClient("Moving to next site...")
    await runInteractiveVerify(socket)
  })

  socket.on("user-skipped-verify", async () => {
    const session = interactiveSessions[socket.id]
    if (!session || stopFlags[socket.id]) {
      logToClient("Session expired or stopped.", "error")
      return
    }

    logToClient("User skipped. Moving to next site...")
    // Continue the loop with the remaining sites
    await runInteractiveVerify(socket)
  })

  // --- Interactive Verify Orchestrator ---
  const runInteractiveVerify = async (socket) => {
    const session = interactiveSessions[socket.id]
    if (stopFlags[socket.id]) {
      logToClient("Process stopped by user.")
      await cleanupSession(socket.id)
      return
    }

    if (!session) {
      logToClient("Session not found. Aborting.", "error")
      return
    }

    // Get the sites list from the session
    const sites = session.sitesRemaining
    const site = sites.shift() // Get next site (this mutates the session's array)

    if (!site) {
      logToClient("All sites processed!", "success")
      await cleanupSession(socket.id)
      return
    }

    if (!site.url || !site.username || !site.password) {
      logToClient(
        `Skipping row: Data is incomplete (URL, user, or pass is missing).`
      )
      // Automatically run next
      await runInteractiveVerify(socket)
      return
    }

    logToClient(`Scanning ${site.url}...`)
    const scanResult = await checkSiteSource(site.url, logToClient)

    switch (scanResult) {
      case "pro":
        logToClient(
          `Pro script found on ${site.url}. Updating sheets...`,
          "success"
        )
        try {
          await updateSheetsForVerifiedSite(site.url, logToClient)
        } catch (e) {
          logToClient(`Failed to update sheets: ${e.message}`, "error")
        }
        // Automatically run next
        await runInteractiveVerify(socket)
        break

      case "other":
        logToClient(
          `ERROR: Another UserWay script was found on ${site.url}.`,
          "error"
        )
        // Automatically run next
        await runInteractiveVerify(socket)
        break

      case "none":
        logToClient(`No UserWay script found on ${site.url}.`)
        // --- PAUSE and ask user ---
        socket.emit("prompt-for-install", { site })
        // The loop stops here and waits for user-confirmed-install or user-skipped-verify
        break

      case "error":
        logToClient(`ERROR: Failed to scan site ${site.url}.`, "error")
        // Automatically run next
        await runInteractiveVerify(socket)
        break

      default:
        logToClient(`Unknown scan result: ${scanResult}`, "error")
        await runInteractiveVerify(socket)
    }
  }

  // --- START: ACCESSIBILITY STATEMENT LOGIC ---

  // --- Orchestrator for Accessibility ---
  const runNextAccessibilityCheck = async (socket) => {
    const session = interactiveSessions[socket.id]
    if (stopFlags[socket.id]) {
      logToClient("Process stopped by user.")
      await cleanupSession(socket.id)
      return
    }
    if (!session) {
      logToClient("Session not found. Aborting.", "error")
      return
    }

    const site = session.sitesRemaining.shift()
    if (!site) {
      logToClient("All done. All accessibility sites processed!", "success")
      await cleanupSession(socket.id)
      return
    }

    session.currentSite = site

    if (!site.url || !site.password) {
      logToClient(
        `[${site.rowIndex}] Skipping: Data incomplete (URL or Pass missing).`
      )
      await runNextAccessibilityCheck(socket) // Recurse
      return
    }

    // --- NEW PRE-CHECK STEP ---
    const logPrefix = `[${site.rowIndex}] ${site.url.replace(
      /^https?:\/\//,
      ""
    )}`
    const siteLogger = (message, level = "info") => {
      logToClient(`${logPrefix} - ${message}`, level)
    }

    try {
      const pageExists = await checkAccessibilityPageExists(
        site.url,
        siteLogger
      )

      if (pageExists) {
        logToClient(
          `[${site.rowIndex}] SKIPPING: /accessibility-statement page already exists.`,
          "warn"
        )
        // Log to sheet even if skipping
        await logAccessibilityStatementResult(
          site.url,
          "",
          "Already Exists",
          logToClient
        )

        // This works for both single and bulk:
        // - In bulk, it moves to the next site.
        // - In single, it finds no more sites and stops.
        await runNextAccessibilityCheck(socket)
        return // Stop processing this site
      }
      logToClient(
        `[${site.rowIndex}] Pre-check OK. Page not found, proceeding with login.`
      )
    } catch (preCheckErr) {
      logToClient(
        `[${site.rowIndex}] ERROR during pre-check: ${preCheckErr.message}. Proceeding anyway.`,
        "error"
      )
      // Don't stop the process, just log the error and proceed with login
    }
    // --- END OF NEW PRE-CHECK STEP ---

    try {
      // processAccessibilityStatement will log in, create the page,
      // and then emit the prompt to the user.
      const result = await processAccessibilityStatement(
        session.browser,
        site,
        logToClient,
        socket
      )

      // --- NEW LOGIC: NEVER RECURSE AUTOMATICALLY ---
      // We just return here. The user "holds" the lock until they click "Scan & Continue".
      // That event handler will call runNextAccessibilityCheck(socket) again.

      // We explicitly emit a pause event if not already handled by a prompting event,
      // just to be safe, although processAccessibilityStatement usually handles success emitted events.
      // If result.shouldRecurse was true in old logic, it meant "done with this site".
      // Now we wait for user confirmation even then?
      // "do not continue to the next in any scenario unless the user presses scan and continue"

      // So effectively, we do NOTHING here. The browser is open, or prompt is shown.
    } catch (err) {
      logToClient(
        `[${site.rowIndex}] ERROR processing ${site.url}: ${err.message}`,
        "error"
      )
      // Error occurred.
      // ERROR LOGIC CHANGE: Do NOT recursing.
      // Pause and let user fix it manually.
      logToClient(
        `[${site.rowIndex}] Pausing for manual intervention. Check browser window.`,
        "warn"
      )
      socket.emit("pause-for-manual-edit", { siteData: site })
    }
  }

  // --- 1. Start "Add for All" ---
  socket.on("start-accessibility-check-all", async () => {
    stopFlags[socket.id] = false
    logToClient("Starting 'Add for All' Accessibility Statements...")

    try {
      const sites = await getAccessibilitySheetData(logToClient)
      logToClient(`Found ${sites.length} sites in the sheet.`)
      if (sites.length === 0) {
        logToClient("No sites found. Stopping.", "error")
        return
      }

      const IS_PRODUCTION =
        process.env.NODE_ENV === "production" || process.env.RENDER
      logToClient(
        `Launching persistent browser (Headless: ${IS_PRODUCTION})...`
      )
      const browser = await puppeteer.launch({
        headless: IS_PRODUCTION ? true : false,
        defaultViewport: null,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--start-maximized"],
      })

      interactiveSessions[socket.id] = { browser, sitesRemaining: sites }
      await runNextAccessibilityCheck(socket) // Start the loop
    } catch (err) {
      logToClient(`FATAL ERROR: ${err.message}`, "error")
      await cleanupSession(socket.id)
    }
  })

  // --- 2. Start "Add for Single" ---
  socket.on("start-accessibility-check-single", async ({ url }) => {
    stopFlags[socket.id] = false
    logToClient(`Starting 'Add Single' for ${url}...`)

    try {
      const sites = await getAccessibilitySheetData(logToClient)
      const site = sites.find((s) => s.url.includes(url)) // Find by URL

      if (!site) {
        logToClient(
          `URL ${url} not found in Accessibility Sheet (Column D).`,
          "error"
        )
        return
      }

      const IS_PRODUCTION =
        process.env.NODE_ENV === "production" || process.env.RENDER
      logToClient(
        `Found site at row ${site.rowIndex}. Launching browser (Headless: ${IS_PRODUCTION})...`
      )
      const browser = await puppeteer.launch({
        headless: IS_PRODUCTION ? true : false,
        defaultViewport: null,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--start-maximized"],
      })

      interactiveSessions[socket.id] = { browser, sitesRemaining: [site] }
      await runNextAccessibilityCheck(socket) // Start the loop
    } catch (err) {
      logToClient(`FATAL ERROR: ${err.message}`, "error")
      await cleanupSession(socket.id)
    }
  })

  // --- 3. User Confirmed Details (STOPS AFTER PUBLISH) ---
  socket.on(
    "user-confirmed-accessibility-details",
    async ({ siteData, businessName, cleanDomain, businessUrl }) => {
      const session = interactiveSessions[socket.id]
      if (!session || stopFlags[socket.id]) {
        logToClient("Session expired or stopped. Aborting.", "error")
        return
      }
      const localLog = (message, level = "info") => {
        logToClient(`[${siteData.rowIndex}] ${message}`, level)
      }

      const { browser } = session
      let wpPage

      try {
        // --- STEP 1: Fetch Statement HTML ---
        const statementHtml = await fetchStatementHtml(
          businessName,
          cleanDomain,
          businessUrl,
          localLog
        )
        // Store HTML in session for logging later
        if (session) session.statementHtml = statementHtml
        localLog("Statement HTML fetched.")

        // --- STEP 2: Find WP Page & Paste ---
        const pages = await browser.pages()
        wpPage = pages.find((p) =>
          p.url().includes("/post-new.php?post_type=page")
        )

        if (!wpPage) {
          throw new Error("Could not find WordPress 'Add Page' tab.")
        }
        await wpPage.bringToFront()

        localLog("Pasting statement into WP...")
        const pastedInClassic = await wpPage.evaluate((html) => {
          const classicEditor = document.querySelector("#content")
          if (classicEditor) {
            const textTab = document.querySelector("#content-html")
            if (textTab) textTab.click()
            classicEditor.value = html
            return true
          }
          return false
        }, statementHtml)

        if (!pastedInClassic) {
          localLog("Classic editor not found. Trying Gutenberg...")
          try {
            await wpPage.evaluate((html) => {
              const el = document.createElement("div")
              el.innerHTML = html
              const blocks = wp.blocks.rawHandler({ HTML: el.innerHTML })
              wp.data.dispatch("core/block-editor").insertBlocks(blocks)
            }, statementHtml)
            localLog("Pasted into Gutenberg successfully.")
          } catch (gutenbergError) {
            throw new Error("Failed to paste content into Gutenberg editor.")
          }
        } else {
          localLog("Pasted into Classic Editor 'Text' tab.")
        }

        // --- STEP 3: Publish Page ---
        await publishPage(wpPage, localLog) // Use our new helper
      } catch (err) {
        localLog(`FAILED: ${err.message}`, "error")
      } finally {
        // --- STEP 4: Pause ---
        localLog("Automation pausing. Please proceed manually.", "warn")
        socket.emit("pause-for-manual-edit", { siteData })
      }
    }
  )

  // --- 4. User Skipped ---
  socket.on("user-skipped-accessibility", async () => {
    const session = interactiveSessions[socket.id]
    if (!session || stopFlags[socket.id]) {
      logToClient("Session expired or stopped.", "error")
      return
    }

    // Close the WP page that was opened
    try {
      const pages = await session.browser.pages()
      const wpPage = pages.find((p) =>
        p.url().includes("/post-new.php?post_type=page")
      )
      if (wpPage) await wpPage.close()
    } catch (e) {
      logToClient("Could not auto-close WP tab.", "warn")
    }

    logToClient("User skipped. Moving to next site...")
    await runNextAccessibilityCheck(socket)
  })

  // --- 5. Bulk Check Only ---
  socket.on("start-accessibility-bulk-check", async () => {
    stopFlags[socket.id] = false
    logToClient("Starting 'Bulk Check' for Accessibility Statements...")

    let sites
    try {
      sites = await getAccessibilitySheetData(logToClient)
      logToClient(`Found ${sites.length} sites to check.`)
    } catch (err) {
      logToClient(`FATAL ERROR getting sheet data: ${err.message}`, "error")
      return
    }

    for (const site of sites) {
      if (stopFlags[socket.id]) {
        logToClient("Stopping bulk check.")
        break
      }
      if (!site.url) continue

      const base = site.url.startsWith("http")
        ? site.url.replace(/\/+$/, "")
        : `https://${site.url.replace(/\/+$/, "")}`
      const checkUrl = `${base}/accessibility-statement`
      logToClient(`[${site.rowIndex}] Checking ${checkUrl}...`)

      try {
        const response = await axios.get(checkUrl, {
          timeout: 10000,
          maxRedirects: 5,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        })

        // Check if we got a 200 OK and weren't redirected away
        const finalUrl = response.request.res.responseUrl
        if (
          response.status === 200 &&
          finalUrl.includes("accessibility-statement")
        ) {
          logToClient(`[${site.rowIndex}] FOUND: ${finalUrl}`, "success")
        } else {
          logToClient(
            `[${site.rowIndex}] NOT FOUND (Redirected): ${site.url}`,
            "error"
          )
        }
      } catch (error) {
        if (error.response && error.response.status === 404) {
          logToClient(
            `[${site.rowIndex}] NOT FOUND (404): ${site.url}`,
            "error"
          )
        } else {
          logToClient(
            `[${site.rowIndex}] ERROR checking ${site.url}: ${error.message}`,
            "error"
          )
        }
      }
    } // end for loop

    if (stopFlags[socket.id]) {
      logToClient("Process stopped by user.")
    } else {
      logToClient("Bulk check complete.", "success")
    }
  })

  // --- END: ACCESSIBILITY STATEMENT LOGIC ---

  // --- NEW: Handle "Scan & Continue" ---
  socket.on("scan-and-continue", async ({ siteData }) => {
    const session = interactiveSessions[socket.id]

    // Check if we are in the "Waiting for Close" state (Cloned Path)
    if (session && session.isWaitingForClose && session.currentPage) {
      logToClient("Closing page to continue...")
      try {
        if (!session.currentPage.isClosed()) {
          await session.currentPage.close()
        }
      } catch (e) {
        // Ignore close errors
      }
      session.isWaitingForClose = false
      session.currentPage = null
    }

    if (!siteData) {
      logToClient("Error: No site data received. Cannot continue.", "error")
      return
    }

    const siteLogger = (message, level = "info") => {
      logToClient(`[${siteData.rowIndex}] ${message}`, level)
    }

    logToClient(
      `[${siteData.rowIndex}] Resuming: Verifying page and content...`
    )

    let verification = { exists: false, contentMatch: false }
    try {
      if (session && session.browser) {
        verification = await verifyAccessibilityPageContent(
          session.browser,
          siteData.url,
          siteLogger
        )
      } else {
        // Fallback if browser session lost (unlikely)
        const exists = await checkAccessibilityPageExists(
          siteData.url,
          siteLogger
        )
        verification = { exists, contentMatch: false }
      }
    } catch (e) {
      logToClient(
        `[${siteData.rowIndex}] Error during verification: ${e.message}`,
        "error"
      )
    }

    let status = "Not Installed"
    let contentToLog = ""

    if (verification.exists) {
      // Recover HTML from session or generate it if missing
      contentToLog = session.statementHtml || ""
      if (!contentToLog) {
        // Try to regenerate if missing (best effort)
        try {
          const cleanDomain = siteData.url
            .replace(/^https?:\/\//, "")
            .replace(/\/+$/, "")
          const businessUrl = `https://${cleanDomain}`
          const businessName = siteData.businessName || "Our Company"
          contentToLog = await fetchStatementHtml(
            businessName,
            cleanDomain,
            businessUrl,
            siteLogger
          )
        } catch (err) {
          logToClient(
            `[${siteData.rowIndex}] Could not regenerate HTML: ${err.message}`,
            "warn"
          )
        }
      }

      if (verification.contentMatch) {
        // Case 1
        status = "Installed"
        logToClient(
          `[${siteData.rowIndex}] SUCCESS: Page exists and content matches reference.`,
          "success"
        )
      } else {
        // Case 2
        status = "Page Added, Content Pending"
        logToClient(
          `[${siteData.rowIndex}] WARN: Page exists but content mismatch.`,
          "warn"
        )
      }
    } else {
      // Case 3
      status = "Not Installed"
      logToClient(`[${siteData.rowIndex}] ERROR: Page not found.`, "error")
    }

    // Log to sheet
    // If exists (Case 1 & 2), we populate content column B.
    // If not exists (Case 3), we leave content column B empty/blank.
    if (verification.exists) {
      await logAccessibilityStatementResult(
        siteData.url,
        contentToLog,
        status,
        logToClient
      )
    } else {
      await logAccessibilityStatementResult(
        siteData.url,
        "",
        status,
        logToClient
      )
    }

    // Clear session HTML for next run
    if (session) session.statementHtml = null

    logToClient(`[${siteData.rowIndex}] Moving to next site...`)
    await runNextAccessibilityCheck(socket)
  })

  // --- NEW: Handle "Scan & Finish" ---
  socket.on("scan-and-finish", async ({ siteData }) => {
    if (!siteData) {
      logToClient("Error: No site data received. Cannot stop.", "error")
      return
    }

    const siteLogger = (message, level = "info") => {
      logToClient(`[${siteData.rowIndex}] ${message}`, level)
    }

    logToClient(
      `[${siteData.rowIndex}] Resuming: Verifying page and content (Scan & Finish)...`
    )

    let verification = { exists: false, contentMatch: false }
    const session = interactiveSessions[socket.id]

    try {
      if (session && session.browser) {
        verification = await verifyAccessibilityPageContent(
          session.browser,
          siteData.url,
          siteLogger
        )
      } else {
        const exists = await checkAccessibilityPageExists(
          siteData.url,
          siteLogger
        )
        verification = { exists, contentMatch: false }
      }
    } catch (e) {
      logToClient(
        `[${siteData.rowIndex}] Error during verification: ${e.message}`,
        "error"
      )
    }

    let status = "Not Installed"
    let contentToLog = ""

    if (verification.exists) {
      contentToLog = (session && session.statementHtml) || ""
      if (!contentToLog) {
        try {
          const cleanDomain = siteData.url
            .replace(/^https?:\/\//, "")
            .replace(/\/+$/, "")
          const businessUrl = `https://${cleanDomain}`
          const businessName = siteData.businessName || "Our Company"
          contentToLog = await fetchStatementHtml(
            businessName,
            cleanDomain,
            businessUrl,
            siteLogger
          )
        } catch (err) {}
      }

      if (verification.contentMatch) {
        status = "Installed"
        logToClient(
          `[${siteData.rowIndex}] SUCCESS: Page exists and content matches.`,
          "success"
        )
      } else {
        status = "Page Added, Content Pending"
        logToClient(
          `[${siteData.rowIndex}] WARN: Page exists but content mismatch.`,
          "warn"
        )
      }
    } else {
      status = "Not Installed"
      logToClient(`[${siteData.rowIndex}] ERROR: Page not found.`, "error")
    }

    // Log to sheet
    if (verification.exists) {
      await logAccessibilityStatementResult(
        siteData.url,
        contentToLog,
        status,
        logToClient
      )
    } else {
      await logAccessibilityStatementResult(
        siteData.url,
        "",
        status,
        logToClient
      )
    }

    if (session) session.statementHtml = null

    await cleanupSession(socket.id)
    logToClient("Process stopped by user.")
  })

  // --- END: ACCESSIBILITY STATEMENT LOGIC ---

  // --- NEW: SOCKET LISTENER FOR SINGLE LOGIN TEST ---
  socket.on("start-single-login-test", async ({ url }) => {
    const log = (msg, level = "info") => logToClient(`[Test] ${msg}`, level)
    log(`Starting login test for: ${url}`)

    let browser
    try {
      // 1. Format URL
      const cleanBaseUrl = url
        .replace(/^https?:\/\//, "") // Remove protocol
        .replace(/\/+$/, "") // Remove trailing slash
      const base = `https://${cleanBaseUrl}`
      const loginPage = `${base}/ghost-login`
      const username = "support.loginuser@growth99.net"

      // 2. Get Password
      const password = await getPasswordForUrl(base, log)

      // 3. Launch Puppeteer
      log("Launching browser for test...")
      browser = await puppeteer.launch({
        headless: true, // Always headless for this quick test
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      })
      const page = await browser.newPage()
      page.setDefaultNavigationTimeout(30000) // 30s timeout

      // 4. Navigate and Login
      log(`Navigating to ${loginPage}...`)
      await page.goto(loginPage, { waitUntil: "domcontentloaded" })

      // --- START: New Login Logic ---
      // 'username' is hardcoded "support.loginuser@growth99.net"
      // 'password' is from getPasswordForUrl
      let loginSuccess = await attemptLogin(page, log, username, password)

      if (!loginSuccess) {
        log(
          "Primary login failed. Retrying with onboarding.india@growth99.com..."
        )
        loginSuccess = await attemptLogin(
          page,
          log,
          "onboarding.india@growth99.com",
          password
        )
      }
      // --- END: New Login Logic ---

      // 5. Check for error and take screenshot
      const loginError = !loginSuccess // Check our new boolean
      const screenshotFile = `login-${
        loginError ? "error" : "success"
      }-${cleanBaseUrl.replace(/[^a-z0-9]/gi, "_")}.png`

      await page.screenshot({ path: screenshotFile, fullPage: true })

      if (loginError) {
        throw new Error("Login failed for both usernames. Check credentials.")
      }

      // 6. Report Success
      log("Login successful.", "success")
      socket.emit("login-test-result", {
        url: cleanBaseUrl,
        status: "success",
        message: "Login Successful",
        screenshot: screenshotFile,
      })
    } catch (err) {
      // 7. Report Error
      log(`Test Failed: ${err.message}`, "error")
      const screenshotFile = `login-error-${url
        .replace(/[^a-z0-9]/gi, "_")
        .slice(0, 50)}.png`

      // Try to take screenshot even on error
      try {
        if (browser) {
          const pages = await browser.pages()
          if (pages[1])
            await pages[1].screenshot({ path: screenshotFile, fullPage: true })
        }
      } catch (e) {}

      socket.emit("login-test-result", {
        url: url,
        status: "error",
        message: err.message,
        screenshot: screenshotFile,
      })
    } finally {
      // 8. Cleanup
      if (browser) {
        await browser.close()
        log("Browser closed.")
      }
    }
  }) // ENHANCED COLOR SCAN LOGIC (FULL REWRITE) // ---------------------------------------------------------------------------
  // --- END: NEW LISTENER ---

  // ---------------------------------------------------------------------------
  socket.on("start-color-scan", async () => {
    stopFlags[socket.id] = false
    logToClient("Starting enhanced Color Scan...")

    const COLOR_SCAN_SHEET_ID = "1woWI26FBmGPz5HGmz6L5-40yts1wRkMaSc2Q18YnBps"
    const READ_RANGE = "Sheet1!D1:D"
    let browser

    try {
      const sheets = await getSheetsApi()
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: COLOR_SCAN_SHEET_ID,
        range: READ_RANGE,
      })
      const rows = res.data.values || []
      const urlsToScan = rows
        .slice(1)
        .map((row, index) => ({
          url: row[0],
          rowIndex: index + 2,
        }))
        .filter((r) => r.url && r.url.trim() !== "")

      if (urlsToScan.length === 0) throw new Error("No URLs found.")

      logToClient(`Found ${urlsToScan.length} URLs. Launching Puppeteer...`)
      browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
      })

      const updates = []

      for (const { url, rowIndex } of urlsToScan) {
        if (stopFlags[socket.id]) {
          logToClient("Stopping scan early...")
          break
        }

        let page
        let colorResult = "ERROR"
        const normalizedUrl = url.startsWith("http")
          ? url
          : `https://${url.replace(/\/+$/, "")}`

        try {
          logToClient(`[${rowIndex}] Opening ${normalizedUrl}`)
          page = await browser.newPage()
          await page.setViewport({ width: 1366, height: 900 })
          page.setDefaultNavigationTimeout(30000)

          await page.goto(normalizedUrl, { waitUntil: "networkidle2" }) // -------- try to close modals/popups -------------

          const popupSelectors = [
            'button[aria-label*="close" i]',
            'a[aria-label*="close" i]',
            ".modal-close",
            ".close",
            "[data-dismiss='modal']",
            ".cookie-banner button",
          ]
          for (const sel of popupSelectors) {
            const buttons = await page.$$(sel)
            for (const b of buttons) {
              try {
                await b.click()
                await page.waitForTimeout(500)
                C
              } catch {}
            }
          } // -------- element finding & computed color -------

          const selectors = [
            ".feature-button",
            "[data-feature-button]",
            ".cta-button",
            "button.primary",
            ".elementor-button",
          ]

          const colorData = await page.evaluate(async (selectors) => {
            function getVisible(el) {
              const rect = el.getBoundingClientRect()
              return (
                rect.width > 10 &&
                rect.height > 10 &&
                getComputedStyle(el).visibility !== "hidden" &&
                getComputedStyle(el).display !== "none"
              )
            }

            function findInShadow(root) {
              for (const sel of selectors) {
                const els = root.querySelectorAll(sel)
                for (const el of els) {
                  if (getVisible(el)) return el
                }
              }
              const shadowHosts = root.querySelectorAll("*")
              for (const host of shadowHosts) {
                if (host.shadowRoot) {
                  const found = findInShadow(host.shadowRoot)
                  if (found) return found
                }
              }
              return null
            }

            const el = findInShadow(document)
            if (!el) return { found: false }

            const cs = getComputedStyle(el)
            return {
              found: true,
              bgColor: cs.backgroundColor,
              bgImage: cs.backgroundImage,
              textColor: cs.color,
              innerText: el.innerText || "",
            }
          }, selectors)

          if (!colorData.found) {
            logToClient(`[${rowIndex}] No .feature-button or similar found.`)
            colorResult = "Not Found"
          } else {
            const { bgColor, bgImage } = colorData
            if (bgImage && bgImage !== "none") {
              colorResult = `Gradient/Image: ${bgImage}`
            } else {
              const hex = rgbToHex(bgColor)
              colorResult = hex
            }
            logToClient(
              `[${rowIndex}] Found color: ${colorResult} (raw: ${colorData.bgColor})`,
              "success"
            )
          } // ---------- screenshot fallback if still unknown ----------

          if (
            colorResult === "Not Found" ||
            colorResult.startsWith("ERROR") ||
            colorResult === "transparent"
          ) {
            try {
              const screenshot = await page.screenshot({ encoding: "base64" })
              const sharp = require("sharp")
              const img = Buffer.from(screenshot, "base64")
              const { data } = await sharp(img)
                .raw()
                .toBuffer({ resolveWithObject: true })
              const [r, g, b] = data
              colorResult = rgbToHex(`rgb(${r},${g},${b})`)
              logToClient(
                `[${rowIndex}] Screenshot fallback color: ${colorResult}`,
                "warn"
              )
            } catch (e) {
              logToClient(
                `[${rowIndex}] Screenshot fallback failed: ${e.message}`,
                "error"
              )
            }
          }
        } catch (err) {
          colorResult = `ERROR: ${err.message.slice(0, 120)}`
          logToClient(`[${rowIndex}] ${colorResult}`, "error")
        } finally {
          try {
            if (page) await page.close()
          } catch {}
        }

        updates.push({
          range: `Sheet1!F${rowIndex}`,
          values: [[colorResult]],
        })
      }

      if (!stopFlags[socket.id] && updates.length > 0) {
        logToClient(`Writing ${updates.length} results to Google Sheet...`)
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: COLOR_SCAN_SHEET_ID,
          resource: {
            valueInputOption: "USER_ENTERED",
            data: updates,
          },
        })
        logToClient("All colors written successfully.", "success")
      }

      logToClient("Enhanced color scan complete.", "success")
    } catch (err) {
      logToClient(`FATAL ERROR: ${err.message}`, "error")
    } finally {
      if (browser) await browser.close()
      if (stopFlags[socket.id]) logToClient("Process stopped by user.")
    }
  }) // ---------------------------------------------------------------------------
}) // --- END: io.on("connection") ---

// --- START: Google Sheets & Puppeteer Helpers ---

// Auth
// Auth
// const SHEETS_AUTH_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
// (getAuthClient and getSheetsApi are already defined at the top of the file)

async function attemptLogin(page, log, username, password) {
  try {
    log(`Attempting login with user: ${username}`)

    // Clear fields first
    await page.evaluate(() => {
      const userField = document.querySelector("#user_login")
      const passField = document.querySelector("#user_pass")
      if (userField) userField.value = ""
      if (passField) passField.value = ""
    })

    // Type credentials
    await page.type("#user_login", username)
    await page.type("#user_pass", password)

    // Click login
    await page.click("#wp-submit") // Just click.

    log("Login button clicked. Waiting for page to load...")

    // Wait for the page to navigate.
    // This might fail if the page reloads in a weird way, so we wrap it.
    try {
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 20000,
      })
    } catch (navError) {
      log(
        `Navigation wait failed (this might be ok on fast reloads): ${navError.message}`,
        "warn"
      )
      // Continue anyway, the page might have loaded.
    }

    // Check for dashboard URL
    const url = page.url()
    if (url.includes("/ghost-admin")) {
      log("Login successful, /ghost-admin/ detected.", "success")
      return true
    }

    // Check for login error message
    // Use waitForSelector for a small time to let the error appear.
    try {
      const errorHandle = await page.waitForSelector("#login_error", {
        timeout: 3000,
      })
      if (errorHandle) {
        const errorText = await page.evaluate(
          (el) => el.textContent,
          errorHandle
        )
        log(`Login failed: ${errorText.trim()}`)
        return false
      }
    } catch (e) {
      // No error message found, which is fine if login was successful
    }

    // Final check if URL is still on login
    if (page.url().includes("ghost-login")) {
      log("Login failed: Still on login page, but no error message found.")
      return false
    }

    log("Login failed: Unknown reason (not at admin, no error).")
    return false
  } catch (err) {
    // This will catch critical errors like page.$ failing
    log(`Critical error during login attempt: ${err.message}`, "error")
    return false
  }
}

// --- NEW: Helper to get a password for a single URL ---
async function getPasswordForUrl(url, log) {
  log(`Authenticating to get password for ${url}...`)
  try {
    const sheets = await getSheetsApi()
    const range = "Sheet1!A:C" // Per request: URL in A, Pass in C
    log(`Fetching passwords from ${BULK_INJECT_SHEET_ID}, range ${range}...`)
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: BULK_INJECT_SHEET_ID,
      range: range,
    })
    const rows = res.data.values
    if (!rows || rows.length === 0) {
      throw new Error("No data found in password sheet.")
    }

    // Find the URL (case-insensitive and trim)
    const cleanUrl = url.toLowerCase().trim()
    for (const row of rows) {
      const sheetUrl = (row[0] || "").toLowerCase().trim()
      if (sheetUrl === cleanUrl) {
        const password = row[2] // Column C
        if (password) {
          log("Password found.", "success")
          return password
        } else {
          throw new Error(`Password found for ${url}, but is empty.`)
        }
      }
    }

    throw new Error(`URL ${url} not found in password sheet (Column A).`)
  } catch (err) {
    log(err.message, "error")
    throw err // Re-throw to be caught by the caller
  }
}

// Read sites from sheet
async function getSitesFromSheet(sheetId, range, credsFile, log) {
  log("Authenticating with Google Sheets...")
  const auth = new google.auth.GoogleAuth({
    keyFile: credsFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  })
  const sheets = google.sheets({ version: "v4", auth })

  log(`Fetching sites from ${sheetId}, range ${range}`)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: range,
  })
  const rows = res.data.values
  if (!rows || rows.length < 2) {
    // Need at least 1 row + header
    throw new Error("No data found in sheet or only header row present")
  }

  log(`Found ${rows.length} total rows in range. Filtering...`)

  // Filter out rows where Column D (the URL, index 3) is empty
  const filteredRows = rows.filter((r) => r[3] && r[3].trim() !== "")

  log(`Found ${filteredRows.length} sites with data in Column D.`)

  return filteredRows.map((r) => ({
    // Range is A1:E. So r[0]=A, r[1]=B, r[2]=C, r[3]=D, r[4]=E
    username: "support.loginuser@growth99.net", // Hardcoded per original script
    url: r[3], // Column D (index 3)
    password: r[4], // Column E (index 4)
  }))
}

// --- Helper to get data for Accessibility Statement ---
async function getAccessibilitySheetData(log) {
  log("Authenticating to get Accessibility Sheet data...")
  try {
    const sheets = await getSheetsApi()
    // --- UPDATED: Range is now D:G ---
    // --- UPDATED: Range is now R:T per user request ---
    // --- UPDATED: Range is now D:G ---
    // --- UPDATED: Read from A:G to avoid relative index confusion ---
    const range = "Sheet1!A:G"
    log(`Fetching from ${ACCESSIBILITY_STATEMENT_SHEET_ID}, range ${range}...`)

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ACCESSIBILITY_STATEMENT_SHEET_ID,
      range: range,
    })
    const rows = res.data.values || []
    log(`Found ${rows.length} rows. Filtering...`)

    return rows
      .map((row, index) => {
        // Now using absolute indices: A=0, B=1, C=2, D=3, E=4
        console.log(`[DEBUG] Row ${index + 1}: D=${row[3]}, E=${row[4]}`)

        return {
          url: row[3], // Column D
          password: row[4], // Column E
          businessName: "",
          rowIndex: index + 1,
        }
      })
      .filter((r) => r.rowIndex > 1) // Skip header row
      .filter(
        (r) =>
          r.url && r.url.trim() !== "" && r.password && r.password.trim() !== ""
      )
  } catch (err) {
    log(`Error getting accessibility sheet data: ${err.message}`, "error")
    throw err
  }
}

// --- NEW: Helper to verify verification page content ---
async function verifyAccessibilityPageContent(browser, siteUrl, log) {
  const base = siteUrl.startsWith("http")
    ? siteUrl.replace(/\/+$/, "")
    : `https://${siteUrl.replace(/\/+$/, "")}`
  const checkUrl = `${base}/accessibility-statement`
  log(`Verifying content at ${checkUrl}...`)

  let page
  try {
    page = await browser.newPage()
    await page.setViewport(null)

    // Navigate and wait for full load
    const response = await page.goto(checkUrl, {
      waitUntil: "networkidle2",
      timeout: 30000,
    })
    const status = response ? response.status() : 0

    if (status === 404) {
      await page.close()
      return { exists: false, contentMatch: false }
    }

    // Get content
    const content = await page.content()
    await page.close()

    // Key phrases from reference.html (headers)
    const keyPhrases = [
      "Accessibility on",
      "Enabling the Accessibility Menu",
      "Disclaimer",
      "Here For You",
      "Contact Us",
    ]

    // Check if at least 3 key phrases are present
    const matchCount = keyPhrases.filter((phrase) =>
      content.includes(phrase)
    ).length
    const contentMatch = matchCount >= 3

    return { exists: true, contentMatch }
  } catch (e) {
    log(`Verification error checking ${checkUrl}: ${e.message}`, "warn")
    if (page) {
      try {
        await page.close()
      } catch {}
    }
    // If navigation failed entirely, assume page doesn't exist or is broken
    return { exists: false, contentMatch: false }
  }
}

// --- NEW: Helper to check for existing accessibility page ---
async function checkAccessibilityPageExists(siteUrl, log) {
  const base = siteUrl.startsWith("http")
    ? siteUrl.replace(/\/+$/, "")
    : `https://${siteUrl.replace(/\/+$/, "")}`

  const pathsToCheck = ["/accessibility-statement", "/accessibility-statement/"]

  for (const path of pathsToCheck) {
    const checkUrl = `${base}${path}`
    log(`Checking for existing page at ${checkUrl}...`)

    try {
      const response = await axios.get(checkUrl, {
        timeout: 10000,
        maxRedirects: 5,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      })

      // Check if we got a 200 OK
      if (response.status === 200) {
        const finalUrl = response.request.res.responseUrl
        const html = response.data ? response.data.toLowerCase() : ""

        // 1. URL Check: Does the final URL contain "accessibility"?
        // We accept redirects if they land on a relevant page.
        if (finalUrl.toLowerCase().includes("accessibility")) {
          log(`FOUND: Page exists at ${finalUrl} (URL match)`, "success")
          return true
        }

        // 2. Content Check: Does the page title or H1 contain "Accessibility Statement"?
        // This handles cases where the URL might be weird but the content is correct.
        if (
          html.includes("<title>accessibility statement") ||
          html.includes("<h1>accessibility statement") ||
          html.includes("accessibility policy")
        ) {
          log(`FOUND: Page exists at ${finalUrl} (Content match)`, "success")
          return true
        }

        // If 200 but neither URL nor content matches, it might be a soft 404 or homepage redirect.
        // We continue to the next path.
      }
    } catch (error) {
      // If 404, just continue to next path
      if (error.response && error.response.status === 404) {
        // continue
      } else {
        log(`Error checking ${checkUrl}: ${error.message}`, "warn")
      }
    }
  }

  log("NOT FOUND: No accessibility statement page found.")
  return false
}

// --- Helper function to publish a page (Classic or Gutenberg) ---
async function publishPage(page, log) {
  log("Publishing page...")
  try {
    // 1. Try Classic Editor
    log("Attempting Classic Editor publish (#publish)...")
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click("#publish"),
    ])
    log("Classic publish successful!")
  } catch (e) {
    // 2. Try Gutenberg
    log("Classic publish failed. Trying Gutenberg publish flow...", "warn")
    // --- Selector for the first "Publish" button ---
    const publishButtonSelector =
      "div.edit-post-header__settings button.editor-post-publish-button__button.is-primary"
    await page.waitForSelector(publishButtonSelector, {
      visible: true,
      timeout: 10000,
    })
    await page.click(publishButtonSelector)

    const panelSelector = ".editor-post-publish-panel"
    await page.waitForSelector(panelSelector, { visible: true, timeout: 5000 })
    log("Gutenberg confirmation panel appeared.")

    // --- UPDATED SELECTOR for the final confirmation button ---
    const confirmButtonSelector =
      ".editor-post-publish-panel__toggle.editor-post-publish-button__button.is-primary"
    await page.waitForSelector(confirmButtonSelector, { visible: true })

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click(confirmButtonSelector),
    ])
    log("Gutenberg publish successful!")
  }
}

// --- NEW: Helper function to fetch statement HTML ---
// --- NEW: Helper function to fetch statement HTML ---
async function fetchStatementHtml(businessName, cleanDomain, businessUrl, log) {
  log("Generating statement from local reference...")
  try {
    const referencePath = path.join(
      __dirname,
      "../client/public/reference.html"
    )
    let html = ""

    if (fs.existsSync(referencePath)) {
      html = fs.readFileSync(referencePath, "utf-8")
    } else {
      log(
        `Template file not found at ${referencePath}. Using fallback template.`,
        "warn"
      )
      html = `
        <h1>Accessibility Statement for {{company_name}}</h1>
        <p>This is an accessibility statement from {{company_name}}.</p>
        <p>We are committed to ensuring that our website is accessible to everyone.</p>
        <p>URL: {{base_url}}</p>
      `
    }

    // Replace placeholders
    // Order matters: replace {{https://base_url}} first to avoid partial matches if {{base_url}} was replaced first
    html = html.split("{{https://base_url}}").join(businessUrl)
    html = html.split("{{base_url}}").join(cleanDomain)
    html = html.split("{{company_name}}").join(businessName)

    log("Statement generated from template.")
    return addMarginsToHtml(html)
  } catch (e) {
    log(`Failed to generate statement: ${e.message}`, "error")
    return `<h1>Error Generating Statement</h1><p>${e.message}</p>`
  }
}

// --- Helper to add margins to specific sections ---
// --- Helper to style specific sections ---
function addMarginsToHtml(html) {
  const $ = cheerio.load(html)
  const headers = [
    "Accessibility on",
    "Enabling the Accessibility Menu",
    "Disclaimer",
    "Here For You",
    "Contact Us",
  ]

  headers.forEach((headerText) => {
    // Find all elements (h1-h6, p, div, strong) that contain the text
    $("h1, h2, h3, h4, h5, h6, p, div, strong").each((i, el) => {
      const text = $(el).text()
      // Check if it contains the header text
      if (text.includes(headerText)) {
        // Check if this element is not just a container for other elements that have the text
        const hasChildWithText = $(el)
          .children()
          .toArray()
          .some((child) => $(child).text().includes(headerText))

        if (!hasChildWithText) {
          // Convert to H2 and add styles
          // We create a new H2 element with the same text
          const newEl = $(`<h2>${$(el).html()}</h2>`)

          // Add styles: font-size + 5px (assuming base is ~16px, lets make it 24px for H2 + 5px = 29px?
          // Or just set a fixed larger size. Let's assume standard H2 is ~24px, +5px = 29px.
          // User asked to "increase size by 5px".
          // Let's set a specific style to ensure it looks right.
          // Also margin-top increased by 15px (original was 20px, so 35px).
          newEl.attr(
            "style",
            "font-size: 24px; margin-top: 35px; font-weight: bold;"
          )

          // Replace the old element with the new H2
          $(el).replaceWith(newEl)
        }
      }
    })
  })

  return $.html()
}

// --- NEW: Puppeteer worker for Accessibility Statement ---
async function processAccessibilityStatement(browser, siteData, log, socket) {
  const { url, password, businessName, rowIndex } = siteData
  const debugPrefix = `[${rowIndex}] ${url.replace(/^https?:\/\//, "")}`
  const localLog = (...args) => log(debugPrefix + " - " + args.join(" "))

  console.log(
    `[DEBUG] processAccessibilityStatement: Business Name for ${url} is: "${businessName}"`
  )

  let page
  try {
    localLog("Starting")
    const base = url.startsWith("http")
      ? url.replace(/\/+$/, "")
      : `https://${url.replace(/\/+$/, "")}`

    // 1. Create Page
    page = await browser.newPage()

    // --- NEW: Store page in session IMMEDIATELY so manual intervention can close it later ---
    if (interactiveSessions[socket.id]) {
      interactiveSessions[socket.id].currentPage = page
      interactiveSessions[socket.id].isWaitingForClose = true // Default state until proven otherwise
    }

    // Set viewport to null to allow full window resizing
    await page.setViewport(null)
    page.setDefaultNavigationTimeout(60000)
    const loginPage = `${base}/ghost-login/`
    localLog(`Navigating to ${loginPage}`)
    await page.goto(loginPage, { waitUntil: "domcontentloaded" })

    // Login with credentials from sheet
    let loginSuccess = await attemptLogin(
      page,
      localLog,
      "onboarding.india@growth99.com",
      password
    )

    if (!loginSuccess) {
      localLog(
        "Login unsuccessful. Attempting to generate statement for manual fallback..."
      )
      const cleanDomain = url
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/+$/, "")
      const businessUrl = `https://${cleanDomain}`

      let fallbackName = "Our Company"
      try {
        // Use the existing Puppeteer page to get the title (more reliable/stealthy than axios)
        const title = await page.title()
        if (title) {
          localLog(`Got page title: "${title}"`)
          // Parsers for "Log In ‹ Site Name — WordPress" or generic "Site Name"
          // Heuristic 1: WordPress Login standard
          const wpMatch = title.match(
            /Log In\s*(?:‹|<)\s*(.+?)\s*(?:—|-)\s*WordPress/i
          )
          if (wpMatch && wpMatch[1]) {
            fallbackName = wpMatch[1].trim()
          } else {
            // Heuristic 2: General "Name | Slogan" or "Name - Slogan"
            const parts = title.split(/[|-]/)
            if (parts.length > 0 && parts[0].trim()) {
              fallbackName = parts[0].trim()
            }
          }
          localLog(`Derived business name: "${fallbackName}"`)
        }
      } catch (e) {
        localLog(`Could not fetch page title: ${e.message}`, "warn")
      }

      try {
        const statementHtml = await fetchStatementHtml(
          fallbackName,
          cleanDomain,
          businessUrl,
          localLog
        )

        if (interactiveSessions[socket.id]) {
          interactiveSessions[socket.id].statementHtml = statementHtml
        }

        socket.emit("display-html-and-pause", { statementHtml, siteData })
        localLog("Statement generated and sent to modal for manual copy.")
      } catch (e) {
        localLog(`Failed to generate fallback statement: ${e.message}`, "error")
        // If we can't generate HTML, we still want to pause, but maybe with a different error?
        // We'll throw here to let the generic error handler catch it.
        throw new Error(
          `Login failed and failed to generate fallback: ${e.message}`
        )
      }

      // successfully "handled" the error by switching to manual mode with HTML
      localLog("Pausing for manual login (HTML provided).")
      return { shouldRecurse: false }
    }

    // 1.5 Fetch Site Title (Real Business Name)
    localLog("Fetching real site title from WordPress...")
    let realBusinessName = businessName // Default to sheet name
    try {
      // Wait for admin bar to ensure page is ready (short timeout)
      try {
        await page.waitForSelector("#wpadminbar", { timeout: 5000 })
      } catch (e) {
        localLog(
          "Admin bar not found within 5s (might be hidden or custom dashboard)."
        )
      }

      const siteInfo = await page.evaluate(() => {
        const adminBarEl = document.querySelector("#wp-admin-bar-site-name > a")
        const adminBarText = adminBarEl ? adminBarEl.innerText.trim() : null
        const docTitle = document.title
        return { adminBarText, docTitle }
      })

      if (siteInfo.adminBarText && siteInfo.adminBarText !== "WordPress") {
        realBusinessName = siteInfo.adminBarText
        localLog(`Found site title (Admin Bar): "${realBusinessName}"`)
      } else if (siteInfo.docTitle) {
        // Try to parse "Dashboard ‹ Site Name — WordPress"
        // Matches "Dashboard", then < or ‹, then capture group, then - or —, then WordPress
        const titleMatch = siteInfo.docTitle.match(
          /Dashboard\s*(?:‹|<)\s*(.+?)\s*(?:—|-)\s*WordPress/i
        )
        if (titleMatch && titleMatch[1]) {
          realBusinessName = titleMatch[1].trim()
          localLog(`Found site title (Document Title): "${realBusinessName}"`)
        } else {
          localLog(
            `Could not parse site title from document title: "${siteInfo.docTitle}". Using sheet name.`
          )
        }
      } else {
        localLog("Could not find site title.")
      }
    } catch (e) {
      localLog(`Error fetching site title: ${e.message}`, "warn")
    }

    // Fallback if realBusinessName is still undefined/null/empty
    if (!realBusinessName || realBusinessName.trim() === "") {
      realBusinessName = "Our Company"
      localLog(
        `Business name could not be determined. Defaulting to "${realBusinessName}".`,
        "warn"
      )
    }

    // 2. Try to Clone "Privacy Policy"
    localLog(
      "Login success. Navigating to 'All Pages' to find Privacy Policy..."
    )
    await page.goto(`${base}/ghost-admin/edit.php?post_type=page`, {
      waitUntil: "networkidle2",
    })

    const cloneLinkHref = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#the-list tr"))
      const privacyRow = rows.find((row) => {
        const titleEl = row.querySelector("a.row-title")
        return (
          titleEl && titleEl.innerText.trim().toLowerCase() === "privacy policy"
        )
      })
      if (!privacyRow) return null
      const cloneLink = privacyRow.querySelector(
        '.clone a, .duplicate a, a[aria-label*="Duplicate"], a[aria-label*="Clone"]'
      )
      return cloneLink ? cloneLink.href : null
    })

    const wasCloned = !!cloneLinkHref
    const cleanDomain = url
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "")
    const businessUrl = `https://${cleanDomain}`

    if (wasCloned) {
      localLog("Found 'Privacy Policy' and a 'Clone' link. Navigating...")
      await page.goto(cloneLinkHref, { waitUntil: "networkidle2" })
      localLog("Clone created. Now on the new draft's edit page.")
    } else {
      localLog(
        "Could not find 'Privacy Policy' or 'Clone' link. Creating a new blank page."
      )
      await page.goto(`${base}/ghost-admin/post-new.php?post_type=page`, {
        waitUntil: "networkidle2",
      })
    }

    // 3. Set Title
    localLog("Setting page title...")
    const setTitleSuccess = await page.evaluate(() => {
      const classicTitle = document.querySelector("#title")
      const gutenbergTitle = document.querySelector(
        "h1.wp-block-post-title[aria-label='Add title']"
      )
      if (classicTitle) {
        classicTitle.value = "Accessibility Statement"
        return true
      }
      if (gutenbergTitle) {
        gutenbergTitle.innerHTML = "Accessibility Statement"
        gutenbergTitle.dispatchEvent(
          new Event("input", { bubbles: true, composed: true })
        )
        return true
      }
      return false
    })
    if (!setTitleSuccess) {
      throw new Error("Could not find title field.")
    }
    localLog("Page title set.")

    // --- 4. NEW LOGIC: Fork based on clone status ---
    // --- 4. NEW LOGIC: Fork based on clone status ---
    if (wasCloned) {
      // --- CLONE PATH ---
      localLog(
        "Cloned page detected. Generating statement HTML *before* attempting publish..."
      )
      let statementHtml = ""
      try {
        statementHtml = await fetchStatementHtml(
          realBusinessName,
          cleanDomain,
          businessUrl,
          localLog
        )
        // Store HTML in session for logging later
        if (interactiveSessions[socket.id]) {
          interactiveSessions[socket.id].statementHtml = statementHtml
        }
        localLog("Statement HTML fetched. Now attempting to publish page...")

        // Try to publish - this might fail, but we have the HTML already
        try {
          await publishPage(page, localLog) // Use our updated helper
        } catch (publishError) {
          localLog(
            `Publish failed: ${publishError.message}. Proceeding to pause.`,
            "error"
          )
        }
      } catch (genError) {
        localLog(
          `Error generating HTML: ${genError.message}. Pausing for manual intervention.`,
          "error"
        )
        statementHtml = "Error generating HTML. Please generate manually."
      }

      // Emit new event to show HTML in a modal/prompt
      localLog("Emitting HTML...")
      socket.emit("display-html-and-pause", { statementHtml, siteData })

      // --- NO LONGER WAIT HERE ---
      // We just exit the function. The "Scan & Continue" button handler will handle the close and continuation.
      return { shouldRecurse: false }
    } else {
      // --- NEW PAGE PATH (Original Flow) ---
      localLog(
        "New page detected. Waiting for user confirmation before generating..."
      )
      socket.emit("prompt-for-accessibility-details", {
        siteData,
        cleanDomain,
        businessName: realBusinessName, // Use fetched name
        businessUrl,
      })
      return { shouldRecurse: false }
    }
  } catch (err) {
    localLog(`ERROR: ${err.message}`, "error")

    // ERROR CHANGED:
    // Do NOT close the page. Leave it open for manual intervention.
    // Rethrow so the orchestrator knows to emission "pause".

    throw err
  }
}

// Puppeteer sleep
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * 500)))
}

// Puppeteer builder detection
async function detectBuilder(page, log) {
  log("Detecting builder...")
  await page.waitForSelector("body", { timeout: 10000 })
  const hasElementor = await page.$("#ghost-admin-bar-elementor_edit_page")
  if (hasElementor) {
    log("Elementor detected.")
    return "elementor"
  }

  const hasWPB = await page.$("#ghost-admin-bar-js_composer-front-editor")
  if (hasWPB) {
    log("WPBakery detected.")
    return "wpbakery"
  }

  log("Builder not detected on front-end. Will check admin menu.")
  const adminElementor = await page.$("a[href*='admin.php?page=elementor']")
  if (adminElementor) {
    log("Elementor detected in admin.")
    return "elementor"
  }

  const adminWPB = await page.$("a[href*='admin.php?page=vc-general']")
  if (adminWPB) {
    log("WPBakery detected in admin.")
    return "wpbakery"
  }

  log("Could not detect Elementor or WPBakery.")
  return "unknown"
}

// Puppeteer install Elementor
const installElementor = async (page, script, log) => {
  log("Navigating to Elementor > Custom Code")
  await page.goto(
    page.url().split("/ghost-admin/")[0] +
      "/ghost-admin/edit.php?post_type=elementor_snippet",
    { waitUntil: "networkidle2" }
  )
  await sleep(1000)

  log('Clicking "Add New"')
  await page.click(
    'a.page-title-action[href*="post-new.php?post_type=elementor_snippet"]'
  )
  await page.waitForNavigation({ waitUntil: "networkidle2" })
  await sleep(1000)

  log("Verifying Elementor Pro 'Custom Code' page...")
  const isCorrectPage = await page.$("body.post-type-elementor_snippet")
  if (!isCorrectPage) {
    log(
      "Elementor Pro 'Custom Code' feature not found. This site may have the free version."
    )
    throw new Error("Elementor Pro 'Custom Code' feature not found.")
  }
  log("Elementor Pro page verified.")

  log('Entering title: "UserWay Accessibility"')
  await page.type("#title", "UserWay Accessibility")

  const editorSelector = ".elementor-custom-code-codemirror .CodeMirror"
  log("Waiting for Elementor Pro Code Editor to load...")
  try {
    await page.waitForSelector(editorSelector, {
      visible: true,
      timeout: 15000,
    })
  } catch (e) {
    log("ERROR: Timed out waiting for CodeMirror editor.")
    throw new Error("CodeMirror editor not found on page.")
  }
  log("Code Editor loaded.")

  log("Checking for existing UserWay script...")
  const existingCode = await page.evaluate((sel) => {
    const cm = document.querySelector(sel).CodeMirror
    return cm.getValue()
  }, editorSelector)

  if (
    existingCode.includes(USERWAY_ACCOUNT_ID) ||
    existingCode.includes("userway.org/widget.js")
  ) {
    log("SKIPPING: UserWay script already found in Elementor Custom Code.")
    return false
  }

  log("Pasting UserWay script...")
  await page.evaluate(
    (script, sel) => {
      const cm = document.querySelector(sel).CodeMirror
      cm.setValue(script)
    },
    script,
    editorSelector
  )

  log('Clicking "Publish" (WordPress button)')
  await page.click("#publish")

  log("Waiting for Elementor 'Publish Settings' modal...")
  await page.waitForSelector(".eps-modal", {
    visible: true,
    timeout: 10000,
  })
  log("Publish modal appeared.")

  try {
    const selectSelector = ".e-site-editor-conditions__input-wrapper select"
    log("Waiting for condition <select> element...")
    await page.waitForSelector(selectSelector, { visible: true })

    log("Setting condition to 'Entire site' (general)...")
    await page.select(selectSelector, "general")
    await sleep(500)

    const saveButtonSelector = ".e-site-editor-conditions__footer .eps-button"
    log('Clicking "Save & Close"...')

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click(saveButtonSelector),
    ])
  } catch (e) {
    log(`ERROR setting condition: ${e.message}`)
    throw new Error("Failed to set condition or click 'Save & Close' in modal.")
  }

  await sleep(2000)
  log("Elementor script installed successfully.")
  return true
}

// Puppeteer install WPBakery
const installWPBakery = async (page, snippet, log) => {
  log("Navigating to WPBakery Page Builder > General Settings")
  await page.goto(
    page.url().split("/ghost-admin/")[0] +
      "/ghost-admin/admin.php?page=vc-general",
    { waitUntil: "networkidle2" }
  )
  await sleep(1000)

  const footerJsSelector = 'textarea[name="wpb_js_footer"]'
  log("Checking for existing script in Custom JS (Footer)...")
  await page.waitForSelector(footerJsSelector, { timeout: 10000 })

  const existingJs = await page.evaluate((sel) => {
    return document.querySelector(sel).value
  }, footerJsSelector)

  if (existingJs.includes(USERWAY_ACCOUNT_ID)) {
    log("SKIPPING: UserWay Account ID already found in WPBakery Custom JS.")
    return false
  }

  log("Account ID not found. Appending script...")
  const newJs = existingJs + "\n\n" + snippet

  await page.evaluate(
    (sel, text) => {
      document.querySelector(sel).value = text
    },
    footerJsSelector,
    newJs
  )

  log('Clicking "Save Changes"')
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click('input[name="save_changes_vc-general"]'),
  ])
  await sleep(1000)
  log("WPBakery script installed successfully.")
  return true
}

// --- Puppeteer Main Worker ---
async function processSite(browser, site, index, log, socketId) {
  const { url, username, password } = site
  const debugPrefix = `[${index}] ${url.replace(/^https?:\/\//, "")}`

  // This 'log' function is local to processSite
  const localLog = (...args) => {
    log(debugPrefix + " - " + args.join(" "))
  }

  const page = await browser.newPage()
  page.setDefaultNavigationTimeout(60000)

  try {
    if (stopFlags[socketId]) throw new Error("Process stopped by user")

    localLog("Starting")
    const base = url.startsWith("http")
      ? url.replace(/\/+$/, "")
      : `https://${url.replace(/\/+$/, "")}`

    localLog(`Navigating to ${base} for pre-check...`)
    await page.goto(base, { waitUntil: "domcontentloaded" })
    await sleep(500) // Allow for any client-side rendering

    const pageSource = await page.content()
    const proScript = `data-account="${USERWAY_ACCOUNT_ID}"`

    if (pageSource.includes(proScript)) {
      await addUrlToDuplicateSheet(url, log)

      localLog(
        "SKIPPING: Pro script already found on the site. No login required."
      )
      await page.close()
      return {
        url,
        status: "skipped",
        builder: "unknown",
        message: "Pro script already present.",
      }
    }
    localLog("Pre-check complete. Pro script not found. Proceeding to login.")

    const loginPage = `${base}/ghost-login`
    localLog(`Navigating to ${loginPage}`)
    await page.goto(loginPage, { waitUntil: "domcontentloaded" })
    await sleep(500)

    if (stopFlags[socketId]) throw new Error("Process stopped by user")

    let loginSuccess = await attemptLogin(page, localLog, username, password)

    if (!loginSuccess) {
      localLog(
        "Primary login failed. Retrying with onboarding.india@growth99.com..."
      )
      loginSuccess = await attemptLogin(
        page,
        localLog,
        "onboarding.india@growth99.com",
        password
      )
    }

    if (!loginSuccess) {
      throw new Error("Login failed for both usernames. Check credentials.")
    }

    if (stopFlags[socketId]) throw new Error("Process stopped by user")

    const builder = await detectBuilder(page, localLog)
    localLog("Detected builder:", builder)

    let installSuccess = false // <-- 1. DECLARE THE VARIABLE
    if (builder === "elementor")
      installSuccess = await installElementor(page, ELEMENTOR_SCRIPT, localLog)
    // <-- 2. CAPTURE THE RESULT
    else if (builder === "wpbakery")
      installSuccess = await installWPBakery(page, WP_BAKERY_SNIPPET, localLog)
    // <-- 2. CAPTURE THE RESULT
    else localLog("Builder unknown or not supported. Skipping.")

    if (installSuccess) {
      localLog("Script addition successful. Updating duplicate sheet...")
      await addUrlToDuplicateSheet(url, log)
    }

    await page.close()
    localLog("Completed")
    return { url, status: "ok", builder }
  } catch (err) {
    console.error(debugPrefix, "ERROR:", err.message)
    log(debugPrefix + " ERROR: " + err.message, "error")
    try {
      await page.screenshot({
        path: `error-${index}-${url.replace(/[^a-zA-Z0-9]/g, "_")}.png`,
        fullPage: true,
      })
    } catch (e) {
      // ignore screenshot error
    }
    await page.close()
    return { url, status: "error", error: err.message }
  }
}

// --- NEW: Helper to check site source ---
async function checkSiteSource(url, log) {
  const proScript = `data-account="${USERWAY_ACCOUNT_ID}"`

  try {
    const fullUrl = url.startsWith("http") ? url : `https://${url}`
    const { data: pageSource } = await axios.get(fullUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 15000,
    })

    if (pageSource.includes(proScript)) {
      return "pro"
    }
    if (pageSource.includes("userway.org/widget")) {
      return "other"
    }
    return "none"
  } catch (error) {
    log(`Failed to fetch ${url}: ${error.message}`, "error")
    return "error"
  }
}

// Replaces the flaky 'append' with an explicit 'batchUpdate'
async function addRowToProSheet(url, activatedDate, log) {
  if (!activatedDate) {
    // Fallback for the interactive verifier which doesn't pass a date
    activatedDate = new Date().toLocaleDateString()
  }

  log(`[addRowToProSheet] Adding ${url} to History Sheet...`)

  try {
    const sheets = await getSheetsApi()

    // 1. Check for duplicates
    const alreadyExists = await isUrlInSheet(
      url,
      ADA_PRO_ID,
      "Complete Master sheet!B:B", // Check Column B
      log
    )
    if (alreadyExists) {
      log(`[addRowToProSheet] SKIPPING: ${url} already exists.`)
      return
    }

    // 2. Find the next empty row by checking Column B
    // We get B1:B to include the header row in the count
    const getRange = "Complete Master sheet!B1:B"
    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: ADA_PRO_ID,
      range: getRange,
    })

    // If sheet has header + 50 sites, length is 51. Next row is 52.
    const lastRow = getRes.data.values ? getRes.data.values.length : 0
    const newRow = lastRow + 1 // +1 to get the next empty row
    log(
      `[addRowToProSheet] Found last row at ${lastRow}, will write to new row ${newRow}.`
    )

    // 3. Prepare explicit cell update requests
    const requests = [
      {
        // URL in B
        range: `Complete Master sheet!B${newRow}`,
        values: [[url]],
      },
      {
        // Active in D
        range: `Complete Master sheet!D${newRow}`,
        values: [["Active"]],
      },
      {
        // Date in F
        range: `Complete Master sheet!F${newRow}`,
        values: [[activatedDate]],
      },
      {
        // Complete in J
        range: `Complete Master sheet!J${newRow}`,
        values: [["Complete"]],
      },
    ]

    // 4. Execute the batch update
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ADA_PRO_ID,
      resource: {
        valueInputOption: "USER_ENTERED",
        data: requests,
      },
    })

    log(
      `[addRowToProSheet] Successfully added ${url} to row ${newRow}.`,
      "success"
    )
  } catch (err) {
    log(`[addRowToProSheet] FATAL ERROR adding row: ${err.message}`, "error")
    throw err // Re-throw to be caught by caller
  }
}

async function updateSheetsForVerifiedSite(url, log) {
  try {
    //  function handles duplicate checks and all sheet logic.
    // We pass null for activatedDate to use today's date as a fallback.
    await addRowToProSheet(url, null, log)
  } catch (e) {
    log(`ERROR in updateSheetsForVerifiedSite: ${e.message}`, "error")
    // Don't throw, just log. The main process shouldn't stop.
  }
  log("Sheets updated successfully.", "success")
}

// --- NEW: Helper to check if URL exists in a sheet ---
async function isUrlInSheet(url, sheetId, range, log) {
  log(`Checking for ${url} in ${sheetId}...`)
  try {
    const sheets = await getSheetsApi()
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: range, // e.g., "Sheet1!B:B"
    })
    const values = res.data.values
    if (values) {
      // values is a 2D array, e.g., [["url1"], ["url2"]]
      const flatList = values.flat()
      return flatList.includes(url)
    }
    return false
  } catch (e) {
    log(`ERROR checking sheet: ${e.message}`, "error")
    return false // Fail safe, assume it doesn't exist
  }
}

// --- NEW: Helper to add URL to Duplicate sheet (for script addition) ---
async function addUrlToDuplicateSheet(url, log) {
  // Request 2: Check if it already exists
  const alreadyExists = await isUrlInSheet(
    url,
    ADA_DUPLICATE_SHEET_ID,
    "Sheet1!B:B", // Check only URL column
    log
  )

  if (alreadyExists) {
    log(
      `Skipping: ${url} already exists in ADA Duplicate Sheet Sheet (from addUrlToDuplicateSheet).`
    )
    return
  }

  // Request 1: Add to B column
  try {
    log(`Appending ${url} to ADA Duplicate Sheet Sheet (post-install)...`)
    const sheets = await getSheetsApi()
    await sheets.spreadsheets.values.append({
      spreadsheetId: ADA_DUPLICATE_SHEET_ID,
      range: "Sheet1!A:B", // Appends to first empty row
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [["", url]], // [Col A, Col B]
      },
    })
    log(`Successfully appended ${url} to ADA Duplicate Sheet Sheet.`, "success")
  } catch (e) {
    log(
      `ERROR appending to ADA Duplicate Sheet Sheet (post-install): ${e.message}`,
      "error"
    )
    // Don't throw, just log the error. The main install was successful.
  }
}

// --- NEW: Helper to log accessibility statement result ---
async function logAccessibilityStatementResult(url, htmlContent, status, log) {
  try {
    log(`Logging accessibility statement result for ${url}...`)
    const sheets = await getSheetsApi()

    // Check for duplicates in the Statement tab (Column A)
    const alreadyExists = await isUrlInSheet(
      url,
      ADA_DUPLICATE_SHEET_ID,
      "Statement!A:A",
      log
    )

    if (alreadyExists) {
      log(
        `SKIPPING: ${url} already exists in ADA Duplicate Sheet (Statement tab).`
      )
      return
    }

    // Append to ADA_DUPLICATE_SHEET_ID
    // Columns: A=URL, B=HTML, C=Status
    await sheets.spreadsheets.values.append({
      spreadsheetId: ADA_DUPLICATE_SHEET_ID,
      range: "Statement!A:C",
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[url, htmlContent, status]],
      },
    })
    log(`Successfully logged result to ADA Duplicate Sheet.`, "success")
  } catch (e) {
    log(`ERROR logging result to ADA Duplicate Sheet: ${e.message}`, "error")
  }
}

// --- END: Google Sheets & Puppeteer Helpers ---

// --- START: API Endpoints ---

// HELPER FUNCTION: Generic function to get sheet data
async function fetchSheetData(spreadsheetId, range) {
  try {
    const sheets = await getSheetsApi()
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    })
    return result.data.values || []
  } catch (error) {
    console.error(
      `Error fetching sheet ${spreadsheetId} range ${range}:`,
      error.message
    )
    throw new Error("Failed to fetch sheet data")
  }
}

//  Get data from the "Existing ADA Customers" tab
app.get("/api/existing-data", async (req, res) => {
  try {
    const data = await fetchSheetData(
      MAIN_SHEET_ID,
      "'Existing Monthly ADA Customers'!A:Z"
    )
    res.json(data)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Get data from the "New ADA customers" tab
app.get("/api/new-data", async (req, res) => {
  try {
    const data = await fetchSheetData(
      MAIN_SHEET_ID,
      "'New Monthly ADA Customers'!A:Z"
    )
    res.json(data)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Get URL data from the ADA Duplicate sheet
app.get("/api/url-data", async (req, res) => {
  try {
    const data = await fetchSheetData(ADA_DUPLICATE_SHEET_ID, "Sheet1!A:Z")
    res.json(data)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// 2. Get history data from ADA Pro sheet
app.get("/api/history-data", async (req, res) => {
  try {
    const data = await fetchSheetData(ADA_PRO_ID, "Complete Master sheet!A:G")
    res.json(data)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// 3. Scan URL
app.post("/api/scan", async (req, res) => {
  const { url } = req.body
  if (!url) {
    return res.status(400).json({ error: "URL is required" })
  }

  try {
    const { data: pageSource } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 10000,
    })
    const basicScript = 'data-account="y0juzG0O0x"'
    const proScript = `data-account="${USERWAY_ACCOUNT_ID}"`
    const hasWidget =
      pageSource.includes("userway.org/widget.js") ||
      pageSource.includes("userway.org/widget")
    const hasBasic = pageSource.includes(basicScript)
    const hasPro = pageSource.includes(proScript)
    if (hasBasic && hasPro) {
      res.json({ isPresent: false, status: "ID Mismatch" })
    } else if (hasBasic) {
      res.json({ isPresent: true, status: "Basic" })
    } else if (hasPro) {
      res.json({ isPresent: true, status: "Pro" })
    } else if (hasWidget) {
      res.json({ isPresent: false, status: "ID Mismatch" })
    } else {
      res.json({ isPresent: false, status: "Not Found" })
    }
  } catch (error) {
    console.error(`Error scanning ${url}:`, error.message)
    res.status(500).json({ isPresent: false, status: "Scan Failed" })
  }
})

// 4. Add entry to ADA Pro
app.post("/api/add-history", async (req, res) => {
  const { websiteUrl, activatedDate } = req.body
  try {
    // New helper handles duplicates and explicit cell writes
    await addRowToProSheet(
      websiteUrl,
      activatedDate,
      console.log // Use console.log for server API logging
    )
    res.json({ success: true })
  } catch (error) {
    console.error("Error in /api/add-history:", error.message)
    res.status(500).json({ error: "Failed to update ADA Pro" })
  }
})

// --- Debounce logic for notifications ---
const notificationTimers = {}
const DEBOUNCE_TIME = 5000
app.post("/api/sheet-update", (req, res) => {
  console.log("Received sheet update:", req.body)
  const updateInfo = req.body
  const range = updateInfo.range
  if (!range) {
    io.emit("sheet-change", updateInfo)
    return res.status(200).send("OK")
  }
  if (notificationTimers[range]) {
    clearTimeout(notificationTimers[range])
    console.log(`Debouncing: Cleared old timer for cell ${range}`)
  }
  console.log(`Setting new 5s timer for cell ${range}`)
  notificationTimers[range] = setTimeout(() => {
    console.log(`Timer Fired: Sending update for ${range}`)
    io.emit("sheet-change", updateInfo)
    delete notificationTimers[range]
  }, DEBOUNCE_TIME)
  res.status(200).send("OK")
})

// --- NEW: Basecamp Scraping Endpoint ---
app.post("/api/basecamp-link", async (req, res) => {
  const { projectName } = req.body
  if (!projectName) {
    return res.status(400).json({ error: "Project Name is required" })
  }
  const directoryUrl = process.env.BASECAMP_DIRECTORY_URL
  try {
    const { data: pageSource } = await axios.get(directoryUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        // 'Cookie': 'PASTE_YOUR_BASECAMP_COOKIE_STRING_HERE'
      },
    })
    const $ = cheerio.load(pageSource)
    let foundLink = null
    $("a.project-list__link").each((i, el) => {
      const title = $(el).attr("title")
      if (title && title.includes(projectName)) {
        const href = $(el).attr("href")
        if (href) {
          foundLink = `https://3.basecamp.com${href}`
          return false
        }
      }
    })
    if (foundLink) {
      res.json({ link: foundLink })
    } else {
      res.status(404).json({ error: "Link not found in directory" })
    }
  } catch (error) {
    console.error(`Failed to scrape Basecamp:`, error.message)
    res.status(500).json({
      error: "Failed to scrape Basecamp. Is it public or is your cookie valid?",
    })
  }
})
// --- END: API Endpoints ---

// --- Start Server ---
const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`)
})
