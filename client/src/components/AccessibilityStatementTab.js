import React, { useState, useEffect, useRef } from "react"

function AccessibilityStatementTab({
  socket,
  logs,
  isChecking,
  setIsChecking,
  isBulkChecking,
  setIsBulkChecking,
  // --- New props ---
  isPaused,
  setIsPaused,
  currentPausedSite,
  setCurrentPausedSite,
}) {
  const [singleUrl, setSingleUrl] = useState("")
  const logEndRef = useRef(null)

  // Auto-scroll the log viewer
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  // --- Check if any job is active ---
  const isJobRunning = isChecking || isBulkChecking || isPaused

  // --- Handlers for starting jobs ---
  const handleCheckSingle = () => {
    if (!singleUrl || !socket) {
      alert("Please enter a URL.")
      return
    }
    setIsChecking(true)
    setIsBulkChecking(false)
    socket.emit("start-accessibility-check-single", { url: singleUrl })
  }

  const handleCheckAll = () => {
    setIsChecking(true)
    setIsBulkChecking(false)
    socket.emit("start-accessibility-check-all")
  }

  const handleBulkCheck = () => {
    setIsBulkChecking(true)
    setIsChecking(false)
    socket.emit("start-accessibility-bulk-check")
  }

  // --- Handlers for running/paused jobs ---

  // This stops a RUNNING job (e.g., in the middle of login)
  const handleStopRunningJob = () => {
    socket.emit("stop-accessibility-check")
  }

  // This is for the "Scan & Continue" button (after pausing)
  const handleScanAndContinue = () => {
    setIsPaused(false)
    setCurrentPausedSite(null)
    setIsChecking(true) // Go back to "running" state
    socket.emit("scan-and-continue", { siteData: currentPausedSite })
  }

  // This is for the "Scan & Finish" button (after pausing)
  const handleScanAndFinish = () => {
    setIsPaused(false)
    setCurrentPausedSite(null)
    // Don't set isChecking, the job is over
    socket.emit("scan-and-finish", { siteData: currentPausedSite })
  }

  return (
    <div className="installer-tab">
      <div className="installer-controls">
        {/* --- SECTION 1: ADD/CHECK SINGLE --- */}
        <h3>Add/Check Single URL</h3>
        <p className="content-description">
          Find a URL in the sheet, log in, and prompt to add the statement.
        </p>
        <div className="control-group">
          <input
            type="text"
            className="search-filter"
            value={singleUrl}
            onChange={(e) => setSingleUrl(e.target.value)}
            placeholder="Enter full URL (e.g., https://domain.com)"
            disabled={isJobRunning}
          />
          {/* Default "Start" button */}
          {!isChecking && !isPaused && (
            <button
              onClick={handleCheckSingle}
              disabled={isJobRunning}
              className="button button-primary"
            >
              Start Single Check
            </button>
          )}

          {/* "Stop" button for a RUNNING job */}
          {isChecking && (
            <button
              onClick={handleStopRunningJob}
              className="button button-destructive"
            >
              Stop
            </button>
          )}

          {/* "Scan & Finish" button for a PAUSED single job */}
          {isPaused && (
            <button
              onClick={handleScanAndFinish}
              className="button button-primary"
              style={{ backgroundColor: "#28a745" }} // Green
            >
              Scan & Finish
            </button>
          )}
        </div>

        <hr />

        {/* --- SECTION 2: ADD FOR ALL --- */}
        <h3>Add Statement for All</h3>
        <p className="content-description">
          Iterate through all sites in the sheet and prompt for each one.
        </p>
        <div className="control-group">
          {/* Default "Start" button */}
          {!isChecking && !isPaused && (
            <button
              onClick={handleCheckAll}
              disabled={isJobRunning}
              className="button button-secondary"
            >
              Start 'Add for All'
            </button>
          )}

          {/* "Stop" button for a RUNNING job */}
          {isChecking && (
            <button
              onClick={handleStopRunningJob}
              className="button button-destructive"
            >
              Stop
            </button>
          )}

          {/* "Scan" buttons for a PAUSED bulk job */}
          {isPaused && (
            <>
              <button
                onClick={handleScanAndContinue}
                className="button button-primary"
                style={{ backgroundColor: "#28a745" }} // Green
              >
                Scan & Continue to Next
              </button>
              <button
                onClick={handleScanAndFinish}
                className="button button-secondary"
              >
                Scan & Finish
              </button>
            </>
          )}
        </div>

        <hr />

        {/* --- SECTION 3: BULK CHECK ONLY --- */}
        <h3>Bulk Check Only</h3>
        <p className="content-description">
          Quickly check all sites in the sheet for an existing
          /accessibility-statement page.
        </p>
        <div className="control-group">
          {!isBulkChecking ? (
            <button
              onClick={handleBulkCheck}
              disabled={isJobRunning}
              className="button button-secondary"
            >
              Start 'Bulk Check Only'
            </button>
          ) : (
            <button
              onClick={handleStopRunningJob} // This button just stops
              className="button button-destructive"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* --- Log Viewer --- */}
      <div className="log-viewer">
        {logs.map((log, index) => (
          <pre key={index} className={`log-line log-${log.level || "info"}`}>
            {log.message}
          </pre>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  )
}

export default AccessibilityStatementTab
