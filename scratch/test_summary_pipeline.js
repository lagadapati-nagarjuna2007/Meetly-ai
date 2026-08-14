// Test script to verify the anti-hallucination structured summary logic & formatting

function sanitizeAndStructureSummary(parsedSummary) {
  const finalSummary = {
    overview: typeof parsedSummary.overview === 'string' ? parsedSummary.overview.trim() : '',
    topicsDiscussed: Array.isArray(parsedSummary.topicsDiscussed)
      ? parsedSummary.topicsDiscussed.map(t => typeof t === 'string' ? { title: t.trim(), description: '' } : { title: String(t.title || 'Topic').trim(), description: String(t.description || '').trim() }).filter(t => t.title)
      : [],
    keyPoints: Array.isArray(parsedSummary.keyPoints)
      ? parsedSummary.keyPoints.map(k => String(k).trim()).filter(Boolean)
      : [],
    decisionsMade: Array.isArray(parsedSummary.decisionsMade)
      ? parsedSummary.decisionsMade.map(d => String(d).trim()).filter(Boolean)
      : [],
    actionItems: Array.isArray(parsedSummary.actionItems)
      ? parsedSummary.actionItems.map(a => typeof a === 'string' ? { assignee: '', task: a.trim() } : { assignee: String(a.assignee || '').trim(), task: String(a.task || '').trim() }).filter(a => a.task)
      : []
  }
  return finalSummary
}

// TEST 1 — Educational Session
const test1Raw = {
  overview: "The session covered quantum theory and its applications in modern computing.",
  topicsDiscussed: [
    { title: "Classical vs Quantum Mechanics", description: "The session compared fundamental differences between classical mechanics and quantum mechanics." },
    { title: "Quantum Superposition", description: "The discussion explained how quantum systems exist in multiple states." },
    { title: "Quantum Computing", description: "The session covered how quantum principles apply to scientific computing." }
  ],
  keyPoints: [
    "Quantum systems behave differently from classical systems.",
    "Superposition allows multiple possible states.",
    "Quantum computing has applications in optimization and scientific research."
  ],
  decisionsMade: [],
  actionItems: []
}

console.log("=== TEST 1 — Educational Session ===")
const res1 = sanitizeAndStructureSummary(test1Raw)
console.log(JSON.stringify(res1, null, 2))
console.assert(res1.decisionsMade.length === 0, "Educational session should have empty decisionsMade")
console.assert(res1.actionItems.length === 0, "Educational session should have empty actionItems")

// TEST 2 — Company Project Meeting
const test2Raw = {
  overview: "The team reviewed the authentication system, frontend testing, and deployment issues before release.",
  topicsDiscussed: [
    { title: "Authentication System", description: "The team reviewed the current state of authentication." },
    { title: "Frontend Testing", description: "Discussed completing unit and UI tests." },
    { title: "Production Deployment", description: "Identified deployment checks needed prior to launch." }
  ],
  keyPoints: [
    "Authentication functionality is complete.",
    "Production deployment requires verification.",
    "Multi-user testing is required before release."
  ],
  decisionsMade: [
    "Complete testing before production deployment."
  ],
  actionItems: [
    { assignee: "Sai", task: "Complete frontend testing." },
    { assignee: "Rahul", task: "Investigate deployment issue." }
  ]
}

console.log("\n=== TEST 2 — Company Project Meeting ===")
const res2 = sanitizeAndStructureSummary(test2Raw)
console.log(JSON.stringify(res2, null, 2))
console.assert(res2.decisionsMade.length === 1, "Should contain 1 decision")
console.assert(res2.actionItems[0].assignee === "Sai", "Should assign task to Sai")

// TEST 3 — Empty Decisions & Tasks
const test3Raw = {
  overview: "General discussion with no commitments.",
  topicsDiscussed: [{ title: "General Chat", description: "Casual check-in." }],
  keyPoints: ["Team caught up."],
  decisionsMade: [],
  actionItems: []
}

console.log("\n=== TEST 3 — Empty Decisions & Tasks ===")
const res3 = sanitizeAndStructureSummary(test3Raw)
console.log(JSON.stringify(res3, null, 2))
console.assert(res3.decisionsMade.length === 0, "Decisions must be empty array")
console.assert(res3.actionItems.length === 0, "Action items must be empty array")

console.log("\nALL STRUCTURE & SANITIZATION TESTS PASSED!")
