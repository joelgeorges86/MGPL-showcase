# UI Patterns, Deep Linking & Composite Scoring (Vibe Coding Manual v5.0.4, Chapters 23.5 & 23.6)

## 1. Dashboard Flow & Horizontal Rows
- Dashboard layouts prefer single-column vertical progression (e.g., Platform Breakdown → Deals Radar → Mod Hub → Fleet Summary) instead of cramped side-by-side multi-card containers.
- Lists use sleek horizontal data rows that display title, status, playtime, platform pills, ratings, and mod badges sideways where density matters.

## 2. Deep Linking & Preselected State
- Cross-tab links must carry preselected state through query parameters, such as `#/platforms?store=steam`, so the target view and tab activate immediately.

## 3. Composite Scoring
- Composite rating displays use: `Composite Score = (Steam Rating % + OpenCritic Score) / 2`.
- Provide explicit fallback handling when only one source is available.

## 4. Explicit Action Trigger Rule (Chapter 23)
- If a UI result depends on three or more independent state variables, reactivity MUST be disabled and recomputation triggered explicitly via a visible user action (e.g., "Analyze", "Calculate Compatibility", "Refresh Matrix").
- Show graceful failure states ("Missing VRAM", "Metadata unavailable", "Refresh device scan required", "Calculation blocked") rather than guessing or silently failing.
