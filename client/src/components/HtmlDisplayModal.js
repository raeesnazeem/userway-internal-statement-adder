import React, { useState, useEffect } from "react"
import "./HtmlDisplayModal.css" // We'll add CSS next

function HtmlDisplayModal({ htmlContent, onClose }) {
  const [copyStatus, setCopyStatus] = useState("Copy HTML")

  useEffect(() => {
    // Reset copy button text when content changes
    setCopyStatus("Copy HTML")
  }, [htmlContent])

  const handleCopy = () => {
    navigator.clipboard
      .writeText(htmlContent)
      .then(() => {
        setCopyStatus("Copied!")
        setTimeout(() => setCopyStatus("Copy HTML"), 2000) // Reset after 2s
      })
      .catch((err) => {
        console.error("Failed to copy HTML:", err)
        setCopyStatus("Error Copying")
      })
  }

  // Prevent closing modal when clicking inside it
  const handleModalContentClick = (e) => {
    e.stopPropagation()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={handleModalContentClick}>
        <h2>Accessibility Statement HTML</h2>
        <p>
          The cloned page was published. Please copy the HTML below and paste it
          into the Elementor editor manually.
        </p>
        <textarea readOnly value={htmlContent} rows="15"></textarea>
        <div className="modal-actions">
          <button onClick={handleCopy} className="button button-primary">
            {copyStatus}
          </button>
          <button onClick={onClose} className="button button-secondary">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export default HtmlDisplayModal
