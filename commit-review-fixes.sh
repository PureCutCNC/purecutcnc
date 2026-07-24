#!/bin/bash
cd /Users/frankp/Projects/worktrees/purecutcnc/issue-356-exported-motion-debug
git add -A
git commit -m "fix: address PR review comments #2, #5, #7

- Remove duplicate Reset button (identical to Fit)
- Add captureMotionTrace test to postprocessor.test.ts
- Add tablet 44px min-height for Z-level select element"
git push
