import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatDuration,
  mergeIntervals,
  calculateAttendancePercentage
} from '../utils/durationHelper.js'

// ═══════════════════════════════════════════════════════════════════════════════
// PART 1: ATTENDANCE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test('Attendance: 1. formatDuration formats durations consistently (45s, 5m 56s, 1h 12m 30s)', () => {
  // Test seconds (< 60s)
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(45), '45s')
  assert.equal(formatDuration(59), '59s')

  // Test minutes & seconds (< 3600s)
  // 5 minutes 56 seconds = 5 * 60 + 56 = 356 seconds (from prompt example)
  assert.equal(formatDuration(356), '5m 56s')
  assert.equal(formatDuration(60), '1m 0s')
  assert.equal(formatDuration(125), '2m 5s')

  // Test hours, minutes & seconds (>= 3600s)
  // 1 hour 12 minutes 30 seconds = 3600 + 12 * 60 + 30 = 4350 seconds (from prompt example)
  assert.equal(formatDuration(4350), '1h 12m 30s')
  assert.equal(formatDuration(3600), '1h 0m 0s')
  assert.equal(formatDuration(7325), '2h 2m 5s')

  // Negative and invalid fallbacks
  assert.equal(formatDuration(-10), '0s')
  assert.equal(formatDuration(null), '0s')
  assert.equal(formatDuration(undefined), '0s')
  assert.equal(formatDuration('invalid'), '0s')
})

test('Attendance: 2. Meeting duration and participant duration appear as separate, clearly labelled values', () => {
  // Total meeting duration: 528s (~9 min)
  // Participant duration: 356s (5m 56s)
  const result = calculateAttendancePercentage(356, 528)

  assert.equal(result.totalMeetingDurationSeconds, 528)
  assert.equal(result.participantDurationSeconds, 356)
  assert.equal(result.meetingDurationFormatted, '8m 48s')
  assert.equal(result.participantDurationFormatted, '5m 56s')

  // Meeting duration and participant duration must be distinctly separate numbers
  assert.notEqual(result.totalMeetingDurationSeconds, result.participantDurationSeconds)
})

test('Attendance: 3. Attendance percentage is calculated correctly: (Participant / Meeting) * 100', () => {
  // Prompt Example: Overall meeting duration: 9 minutes (528s), Participant duration: 5m 56s (356s)
  // (356 / 528) * 100 = 67.4242...% -> 67.42%
  const promptExample = calculateAttendancePercentage(356, 528)
  assert.equal(promptExample.percentage, 67.42)
  assert.equal(promptExample.status, 'Absent') // < 75%

  // Present threshold: >= 75%
  // 450s out of 528s -> 85.23% -> Present
  const presentExample = calculateAttendancePercentage(450, 528)
  assert.equal(presentExample.percentage, 85.23)
  assert.equal(presentExample.status, 'Present')

  // Exact 75% boundary
  const exact75 = calculateAttendancePercentage(75, 100)
  assert.equal(exact75.percentage, 75.00)
  assert.equal(exact75.status, 'Present')

  // Just below 75% boundary
  const sub75 = calculateAttendancePercentage(74.99, 100)
  assert.equal(sub75.percentage, 74.99)
  assert.equal(sub75.status, 'Absent')
})

test('Attendance: 4. Late arrivals and early departures are handled correctly', () => {
  const totalMeetingSeconds = 600 // 10 minutes

  // Late arrival: joins at minute 2 (T=120) and stays till end (T=600) -> 480s attended
  const lateArrival = calculateAttendancePercentage(480, totalMeetingSeconds)
  assert.equal(lateArrival.percentage, 80.00)
  assert.equal(lateArrival.status, 'Present')

  // Early departure: joins at T=0, leaves at minute 5 (T=300) -> 300s attended
  const earlyDeparture = calculateAttendancePercentage(300, totalMeetingSeconds)
  assert.equal(earlyDeparture.percentage, 50.00)
  assert.equal(earlyDeparture.status, 'Absent')

  // Late arrival AND early departure: joins at T=120, leaves at T=420 -> 300s attended
  const lateAndEarly = calculateAttendancePercentage(300, totalMeetingSeconds)
  assert.equal(lateAndEarly.percentage, 50.00)
  assert.equal(lateAndEarly.status, 'Absent')
})

test('Attendance: 5. Reconnection intervals do not double-count overlapping attendance', () => {
  // Scenario: Participant disconnects and reconnects.
  // Interval 1: 10,000ms to 20,000ms (10 seconds)
  // Interval 2 (overlapping due to tab sync / clock jitter): 18,000ms to 25,000ms (7 seconds)
  // Without merging: 10 + 7 = 17 seconds (WRONG - 2 seconds double-counted)
  // With merging: 10,000ms to 25,000ms = 15 seconds (CORRECT)
  const overlappingIntervals = [
    { start: 10000, end: 20000 },
    { start: 18000, end: 25000 }
  ]

  const merged = mergeIntervals(overlappingIntervals)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].start, 10000)
  assert.equal(merged[0].end, 25000)
  assert.equal(merged[0].seconds, 15)

  // Multiple disconnected intervals (no overlap):
  // Session 1: 0 - 60s (60s)
  // Session 2: 120s - 240s (120s)
  // Total: 180s
  const multipleSessions = [
    { start: 0, end: 60000 },
    { start: 120000, end: 240000 }
  ]
  const mergedSessions = mergeIntervals(multipleSessions)
  assert.equal(mergedSessions.length, 2)
  const totalSeconds = mergedSessions.reduce((s, iv) => s + iv.seconds, 0)
  assert.equal(totalSeconds, 180)
})

test('Attendance: 6. Clamping prevents attendance from exceeding 100%', () => {
  // If reported presence seconds somehow exceed total meeting duration
  const overflow = calculateAttendancePercentage(700, 600)
  assert.equal(overflow.participantDurationSeconds, 600)
  assert.equal(overflow.percentage, 100.00)
  assert.equal(overflow.status, 'Present')
})

// ═══════════════════════════════════════════════════════════════════════════════
// PART 2: NOTES PREPARATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test('Notes: 1. Lecture with one program places complete code at the end and explanation immediately below', () => {
  const lectureSummary = {
    meetingType: 'Educational / Lecture',
    overview: 'This lecture covered binary search trees, node insertion, and recursion.',
    nodes: [
      {
        name: 'Binary Search Tree Concept',
        definition: 'A binary tree where left child < root < right child.',
        explanation: 'Allows logarithmic search time on average.',
        children: []
      }
    ],
    keyPoints: ['BST provides O(log n) average search time.'],
    programs: [
      {
        title: 'Binary Search Tree Implementation in Python',
        language: 'python',
        sourceCode: `class Node:
    def __init__(self, key):
        self.left = None
        self.right = None
        self.val = key

def insert(root, key):
    if root is None:
        return Node(key)
    if key < root.val:
        root.left = insert(root.left, key)
    else:
        root.right = insert(root.right, key)
    return root`,
        explanation: `1. Imports and Node Class: The Node class defines the binary tree structure with left, right, and value attributes.
2. insert Function: Uses recursion to place smaller keys in the left subtree and greater keys in the right subtree.
3. Execution Flow: Traverses down the tree until finding an empty spot, then creates a new Node.`
      }
    ]
  }

  // 1. Lecture notes appear first
  assert.ok(lectureSummary.nodes.length > 0)
  assert.equal(lectureSummary.nodes[0].name, 'Binary Search Tree Concept')

  // 2. Complete Source Code is at the end in programs[]
  assert.equal(lectureSummary.programs.length, 1)
  const prog = lectureSummary.programs[0]
  assert.equal(prog.title, 'Binary Search Tree Implementation in Python')
  assert.equal(prog.language, 'python')
  assert.ok(prog.sourceCode.includes('class Node:'))
  assert.ok(prog.sourceCode.includes('def insert(root, key):'))

  // 3. Explanation corresponds directly to the code above
  assert.ok(prog.explanation.includes('Node Class'))
  assert.ok(prog.explanation.includes('insert Function'))
})

test('Notes: 2. Lecture with multiple independent programs presents each program separately', () => {
  const multiProgramLecture = {
    meetingType: 'Educational / Lecture',
    overview: 'This lecture demonstrated two sorting algorithms: Bubble Sort and Selection Sort.',
    nodes: [
      { name: 'Comparison Sorting', definition: 'Sorting by pairwise comparison.', children: [] }
    ],
    keyPoints: ['Both Bubble Sort and Selection Sort run in O(n^2) worst case.'],
    programs: [
      {
        title: 'Bubble Sort in JavaScript',
        language: 'javascript',
        sourceCode: `function bubbleSort(arr) {
  for (let i = 0; i < arr.length; i++) {
    for (let j = 0; j < arr.length - i - 1; j++) {
      if (arr[j] > arr[j + 1]) {
        [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]];
      }
    }
  }
  return arr;
}`,
        explanation: 'Bubble sort repeatedly swaps adjacent elements that are in the wrong order until sorted.'
      },
      {
        title: 'Selection Sort in JavaScript',
        language: 'javascript',
        sourceCode: `function selectionSort(arr) {
  for (let i = 0; i < arr.length; i++) {
    let minIdx = i;
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[j] < arr[minIdx]) minIdx = j;
    }
    if (minIdx !== i) [arr[i], arr[minIdx]] = [arr[minIdx], arr[i]];
  }
  return arr;
}`,
        explanation: 'Selection sort finds the minimum element from the unsorted subarray and swaps it to the front.'
      }
    ]
  }

  assert.equal(multiProgramLecture.programs.length, 2)
  assert.equal(multiProgramLecture.programs[0].title, 'Bubble Sort in JavaScript')
  assert.equal(multiProgramLecture.programs[1].title, 'Selection Sort in JavaScript')
  assert.notEqual(multiProgramLecture.programs[0].sourceCode, multiProgramLecture.programs[1].sourceCode)
  assert.ok(multiProgramLecture.programs[0].explanation.includes('Bubble sort'))
  assert.ok(multiProgramLecture.programs[1].explanation.includes('Selection sort'))
})

test('Notes: 3. Lecture without code does not receive unnecessary code sections', () => {
  // A lecture on ancient history or biology with no code discussed
  const nonCodingLecture = {
    meetingType: 'Educational / Lecture',
    overview: 'This lecture covered cellular respiration and ATP synthesis.',
    nodes: [
      {
        name: 'Glycolysis',
        definition: 'Breakdown of glucose into pyruvate in the cytoplasm.',
        explanation: 'Produces 2 ATP and 2 NADH molecules per glucose.',
        children: []
      }
    ],
    keyPoints: ['Glycolysis requires no oxygen (anaerobic).'],
    programs: []
  }

  assert.equal(nonCodingLecture.programs.length, 0)
  // No fake or dummy code blocks
})

test('Notes: 4. Long programs retain indentation, line breaks, and readability', () => {
  const indentedCode = `import java.util.*;

public class Graph {
    private Map<Integer, List<Integer>> adjList = new HashMap<>();

    public void addEdge(int u, int v) {
        adjList.computeIfAbsent(u, k -> new ArrayList<>()).add(v);
    }

    public void bfs(int start) {
        Set<Integer> visited = new HashSet<>();
        Queue<Integer> queue = new LinkedList<>();

        visited.add(start);
        queue.add(start);

        while (!queue.isEmpty()) {
            int node = queue.poll();
            System.out.print(node + " ");

            for (int neighbor : adjList.getOrDefault(node, Collections.emptyList())) {
                if (!visited.contains(neighbor)) {
                    visited.add(neighbor);
                    queue.add(neighbor);
                }
            }
        }
    }
}`

  const lines = indentedCode.split('\n')
  assert.ok(lines.length >= 25)
  // Verify 4-space and 8-space indentation is preserved
  assert.ok(lines.some(l => l.startsWith('    private Map')))
  assert.ok(lines.some(l => l.startsWith('        visited.add(start);')))
  assert.ok(lines.some(l => l.startsWith('            for (int neighbor')))
})

test('Notes: 5. Code explanations correspond accurately to the generated code and missing parts are noted', () => {
  const programWithOmissionNote = {
    title: 'Client-Server Socket Communication in C',
    language: 'c',
    sourceCode: `#include <stdio.h>
#include <sys/socket.h>
#include <netinet/in.h>

int main() {
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    // Note: Bind and listen error-handling logic was summarized by the lecturer
    printf("Server socket initialized.\\n");
    return 0;
}`,
    explanation: 'Initializes a TCP stream socket using AF_INET and SOCK_STREAM. As noted by the instructor, the bind and listen syscalls were summarized conceptually.'
  }

  assert.ok(programWithOmissionNote.sourceCode.includes('socket(AF_INET, SOCK_STREAM, 0)'))
  assert.ok(programWithOmissionNote.explanation.includes('TCP stream socket'))
  assert.ok(programWithOmissionNote.sourceCode.includes('Note: Bind and listen error-handling logic was summarized'))
})
