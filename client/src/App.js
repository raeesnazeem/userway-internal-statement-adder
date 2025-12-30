import React, { useState, useEffect } from "react"
import { io } from "socket.io-client"
import AccessibilityStatementTab from "./components/AccessibilityStatementTab"
import HtmlDisplayModal from "./components/HtmlDisplayModal"
import "./App.css"

// --- Configuration ---
const SOCKET_URL = process.env.REACT_APP_API_URL || "http://localhost:3001"

// --- Main App Component ---
function App() {
  const [socket, setSocket] = useState(null)
  const [bulkInjectLogs, setBulkInjectLogs] = useState([])

  // --- State for Accessibility Statement Tab ---
  const [isCheckingAccessibility, setIsCheckingAccessibility] = useState(false)
  const [isBulkCheckingAccessibility, setIsBulkCheckingAccessibility] =
    useState(false)
  const [isAccessibilityPaused, setIsAccessibilityPaused] = useState(false)
  const [currentPausedSite, setCurrentPausedSite] = useState(null)
  const [showHtmlModal, setShowHtmlModal] = useState(false)
  const [modalHtmlContent, setModalHtmlContent] = useState("")

  // --- Socket.io Setup ---
  useEffect(() => {
    const newSocket = io(SOCKET_URL)
    setSocket(newSocket)
    newSocket.on("connect", () => console.log("Socket.io connected"))

    // --- Socket Listeners for Accessibility Statement ---
    newSocket.on("bulk-inject-log", (logData) => {
      const newLog =
        typeof logData === "string"
          ? { message: logData, level: "info" }
          : logData
      setBulkInjectLogs((prevLogs) => [...prevLogs.slice(-200), newLog])

      // Reset job states on completion
      const stopMessages = ["Process stopped by user", "Bulk check complete"]

      if (stopMessages.some((msg) => newLog.message.includes(msg))) {
        setIsCheckingAccessibility(false)
        setIsBulkCheckingAccessibility(false)
        setIsAccessibilityPaused(false)
      }
    })

    newSocket.on(
      "prompt-for-accessibility-details",
      ({ siteData, cleanDomain, businessName, businessUrl }) => {
        setIsCheckingAccessibility(true)
        const message = `
Verify details for: ${siteData.url}
-----------------------------------
Business Name: ${businessName}
Business Domain: ${cleanDomain}
Business URL: ${businessUrl}
-----------------------------------
Click OK to generate and publish the statement.
Click Cancel to skip this site.
`
        if (window.confirm(message)) {
          setBulkInjectLogs((prev) => [
            {
              message: `User confirmed details for ${siteData.url}. Generating...`,
              level: "info",
            },
            ...prev,
          ])
          newSocket.emit("user-confirmed-accessibility-details", {
            siteData,
            businessName,
            cleanDomain,
            businessUrl,
          })
        } else {
          setBulkInjectLogs((prev) => [
            {
              message: `User skipped statement for ${siteData.url}. Moving to next...`,
              level: "info",
            },
            ...prev,
          ])
          newSocket.emit("user-skipped-accessibility")
        }
      }
    )

    newSocket.on("display-html-and-pause", ({ statementHtml, siteData }) => {
      setModalHtmlContent(statementHtml)
      setShowHtmlModal(true)

      setBulkInjectLogs((prev) => [
        ...prev.slice(-200),
        {
          message:
            "Cloned page published. HTML modal displayed. Automation paused.",
          level: "warn",
        },
      ])
      setIsCheckingAccessibility(false)
      setIsAccessibilityPaused(true)
      setCurrentPausedSite(siteData)
    })

    newSocket.on("pause-for-manual-edit", ({ siteData }) => {
      setBulkInjectLogs((prev) => [
        ...prev,
        {
          message: "Automation paused. Please proceed with manual edits.",
          level: "warn",
        },
      ])
      setIsCheckingAccessibility(false)
      setIsAccessibilityPaused(true)
      setCurrentPausedSite(siteData)
    })

    return () => newSocket.close()
  }, [])

  // --- Render ---
  return (
    <div className="App">
      <h1>Accessibility Statement Dashboard</h1>

      <main className="tab-content">
        <AccessibilityStatementTab
          socket={socket}
          logs={bulkInjectLogs}
          isChecking={isCheckingAccessibility}
          setIsChecking={setIsCheckingAccessibility}
          isBulkChecking={isBulkCheckingAccessibility}
          setIsBulkChecking={setIsBulkCheckingAccessibility}
          isPaused={isAccessibilityPaused}
          setIsPaused={setIsAccessibilityPaused}
          currentPausedSite={currentPausedSite}
          setCurrentPausedSite={setCurrentPausedSite}
        />
      </main>

      {showHtmlModal && (
        <HtmlDisplayModal
          htmlContent={modalHtmlContent}
          onClose={() => {
            setShowHtmlModal(false)
          }}
        />
      )}
    </div>
  )
}

export default App
