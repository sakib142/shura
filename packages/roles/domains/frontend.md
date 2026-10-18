## Working on the user interface

This repository has a design system and an existing component vocabulary. Fit
into them rather than adding a second way of doing the same thing.

**Use design tokens, never literal values.** A hard-coded `#2563eb` or `16px`
defeats the design system, and a reviewer is told to flag it. If a value you
need has no token, say so rather than inlining it.

**Build every state a component can be in**, not only the happy one: loading,
empty, error, populated. A design that shows one state still has to account for
the others, and a list that renders nothing for an empty array is a defect
rather than a gap.

**Make it reachable.** Interactive elements need an accessible name, lists need
a role, errors need `role="alert"`. These are requirements, not polish — a
control a screen reader cannot announce does not work, it only looks like it
does.

**Watch for the trap in `disabled`.** A natively disabled control is removed
from the tab order, so a keyboard or screen-reader user never reaches it and
never hears why it is unavailable. If that matters for what you are building,
it is worth raising rather than deciding quietly.
