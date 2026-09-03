# Lander — Developer Guide & Autopilot Documentation

This document is intended for developers working on the **Lander** JavaScript game, with particular emphasis on the autopilot system.

The repository is a dependency-free browser game built with plain JavaScript, HTML, CSS, and the Canvas API. The autopilot is implemented as a small control loop that drives the existing `lander` control API; it does **not** directly modify the physics engine.

---

## 1. Repository Architecture

The main game flow starts in `index.js`.

Relevant files:

| File | Responsibility |
|---|---|
| `index.js` | Creates the game state, lander, controls, autopilot, terrain, animation loop, and round lifecycle |
| `autopilot.js` | Automatic attitude and engine controller |
| `lander/lander.js` | Lander physics, state, collision detection, scoring data, and public control API |
| `lander/controls.js` | Human keyboard/touch controls |
| `lander/trajectory.js` | Draws the player's trajectory |
| `terrain.js` | Generates terrain and landing surfaces |
| `helpers/constants.js` | Physics/game constants such as gravity, thrust, crash limits, and frame interval |
| `helpers/scoring.js` | Landing/crash scoring and hoverslam detection |
| `index.html` | Game UI, including the autopilot status indicator |
| `style.css` | Game layout and HUD styling |

The autopilot is intentionally isolated from the physics implementation:

```text
index.js
   │
   ├── makeLander(...)
   │       │
   │       └── public physics/control API
   │
   └── makeAutopilot(lander)
           │
           └── reads state + calls lander controls
```

This separation is important: changes to the autopilot should generally be made in `autopilot.js`, while changes to how thrust/rotation physically behave belong in `lander/lander.js`.

---

# 2. Autopilot Overview

The autopilot is implemented in:

```text
autopilot.js
```

It is created in `index.js`:

```js
const lander = makeLander(appState, onGameEnd);
const autopilot = makeAutopilot(lander);
```

It is then enabled for keyboard users after the tutorial has been completed:

```js
landerControls.attachEventListeners();
autopilot.attachEventListeners();
```

The user toggles it with:

```text
P
```

The UI displays:

```text
Autopilot (P) ON
Autopilot (P) OFF
```

using:

```html
<span id="autopilotStatus">OFF</span>
```

### Important distinction

The autopilot is **not a full landing planner**.

It does not:

- select a landing pad
- calculate a route to a specific pad
- inspect terrain geometry
- predict future collisions
- explicitly calculate time-to-impact
- use the trajectory renderer
- control thrust magnitude
- perform throttle modulation
- avoid asteroids
- activate the shield
- intentionally optimize score or bonus points

Instead, it is a lightweight feedback controller that tries to keep the lander upright, cancel horizontal drift, and maintain a manageable vertical descent speed.

---

# 3. The Autopilot Control Loop

`autopilot.js` uses `window.requestAnimationFrame()`:

```js
const run = () => {
    // read lander state
    // calculate desired rotation
    // decide engine state

    if (running) {
        window.requestAnimationFrame(run);
    }
};
```

When autopilot is switched on:

```js
const on = () => {
    running = true;
    window.requestAnimationFrame(run);
    document.querySelector("#autopilotStatus").textContent = "ON";
};
```

When switched off:

```js
const off = () => {
    running = false;

    lander.engineOff();
    lander.stopLeftRotation();
    lander.stopRightRotation();

    document.querySelector("#autopilotStatus").textContent = "OFF";
};
```

### Why `requestAnimationFrame`?

The autopilot is synchronized with the browser's rendering cycle rather than using a separate timer. This keeps the controller responsive and avoids creating another independent interval loop.

The actual physics still runs from the game's main animation loop in `index.js`.

---

# 4. Attitude Stabilization

The first major job of the autopilot is to keep the lander upright.

The lander's angle is stored in radians:

```js
lander.getAngle()
```

The autopilot converts it to turns:

```js
const angleInTurns = turnModulo(
    lander.getAngle() / (Math.PI * 2)
);
```

`turnModulo()` normalizes the angle to approximately:

```text
-0.5 ... +0.5 turns
```

This prevents the controller from treating an angle just past a full rotation as a huge error.

For example, an orientation near a full 360° rotation is treated as being close to upright rather than nearly one full turn away.

---

## 4.1 Target angular velocity

The autopilot does not simply say:

> "If tilted right, rotate left."

Instead it calculates a target rotation rate:

```js
const targetAngularVelocity = -angleInTurns * 5;
```

This means:

- small angle error → small desired rotation rate
- large angle error → stronger desired rotation rate
- the desired rotation rate changes continuously as the lander approaches upright

This is a simple proportional attitude controller.

Conceptually:

```text
desired rotation
        ↓
target angular velocity
        ↓
compare with current angular velocity
        ↓
choose left/right booster
```

---

## 4.2 Angular velocity correction

The current angular velocity is:

```js
lander.getRotationVelocity()
```

The controller calculates:

```js
const angularVelocityDiff =
    lander.getRotationVelocity() - targetAngularVelocity;
```

Then it chooses a rotation command:

```js
if (angularVelocityDiff < -0.001) {
    lander.stopLeftRotation();
    lander.rotateRight();
} else if (angularVelocityDiff > 0.001) {
    lander.stopRightRotation();
    lander.rotateLeft();
} else {
    lander.stopLeftRotation();
    lander.stopRightRotation();
}
```

The `0.001` threshold acts as a small deadband. Without it, the controller could continually alternate controls while the angular error is extremely small.

### Developer note

The exact meaning of `rotateLeft()` and `rotateRight()` comes from the lander's physics implementation. The autopilot should therefore continue using these public methods rather than modifying `_rotationVelocity` directly.

---

# 5. Horizontal Drift Correction

The autopilot also monitors horizontal velocity:

```js
lander.getVelocity().x
```

It determines whether the engine is currently pointing in a direction that opposes horizontal motion:

```js
engineFacingOppositeOfXVelocity =
    Math.abs(lander.getVelocity().x) > 0.005 &&
    lander.getVelocity().x > 0 !== angleInTurns > 0;
```

The goal is to exploit the main engine's sideways thrust component.

The lander's physics applies engine thrust as:

```js
_velocity.x += thrust * Math.sin(angle);
_velocity.y -= thrust * Math.cos(angle);
```

Therefore, when the lander is tilted, the main engine can affect both:

- vertical velocity
- horizontal velocity

The autopilot uses this behavior rather than trying to directly manipulate horizontal velocity.

### Practical result

If the lander is drifting sideways and is tilted so that the engine's horizontal component opposes that drift, the autopilot turns the engine on.

This is one of the key characteristics of this autopilot: **attitude control and horizontal correction are coupled through the main engine.**

---

# 6. Vertical-Speed Control

The autopilot calculates a target vertical velocity:

```js
const targetVelocity =
    Math.max(0, lander.getPosition().y / 160) ** 0.5;
```

This uses the lander's vertical position as a simple altitude-based descent-speed target.

The general behavior is:

- higher altitude → a larger allowed vertical speed
- closer to the ground → a smaller target vertical speed
- the target approaches zero near the ground

The engine is requested when:

```js
lander.getVelocity().y > targetVelocity
```

provided the lander is reasonably upright:

```js
Math.abs(angleInTurns) < 0.25
```

So the autopilot attempts to slow descent near the ground without trying to perform the same vertical correction while the lander is heavily tilted.

---

# 7. Death-Spiral Recovery

There is a special recovery mode for very high angular velocity.

The controller detects:

```js
Math.abs(lander.getRotationVelocity()) > 1
```

When this happens:

```js
engineFacingOppositeOfXVelocity = false;
deathSpiralRecovery = Math.abs(angleInTurns) < 0.25;
```

This does two things:

1. Prevents the normal horizontal-drift condition from deciding whether the engine should run.
2. Allows the engine to run when the lander is moving very rapidly rotationally but happens to be within roughly ±0.25 turns of upright.

The intention is to give the lander a chance to recover from unstable rotation rather than allowing normal horizontal/vertical logic to dominate during an extreme spin.

---

# 8. Engine Decision Priority

The final engine decision is:

```js
if (
    deathSpiralRecovery ||
    engineFacingOppositeOfXVelocity ||
    (lander.getVelocity().y > targetVelocity &&
        Math.abs(angleInTurns) < 0.25)
) {
    lander.engineOn();
} else {
    lander.engineOff();
}
```

The three engine-on conditions are therefore:

### Condition A — Death spiral recovery

```text
very high angular velocity
+
near-upright attitude
```

### Condition B — Horizontal drift cancellation

```text
meaningful X velocity
+
current engine direction opposes that X velocity
```

### Condition C — Vertical descent control

```text
vertical velocity exceeds altitude-based target
+
lander is reasonably upright
```

Otherwise the engine is turned off.

---

# 9. What the Autopilot Can and Cannot Control

## It can control

Through the existing lander API:

```js
lander.engineOn();
lander.engineOff();

lander.rotateLeft();
lander.rotateRight();

lander.stopLeftRotation();
lander.stopRightRotation();
```

## It can read

```js
lander.getAngle();
lander.getRotationVelocity();
lander.getPosition();
lander.getVelocity();
```

## It cannot currently control directly

The autopilot has no API for:

```text
throttle percentage
fuel
target landing position
target landing surface
shield activation
direct velocity changes
direct position changes
direct rotation-velocity changes
```

This is deliberate. The autopilot operates through the same control abstraction that a human player uses.

---

# 10. No Direct Physics Modification

A developer should **not** add code like this to the autopilot:

```js
lander._velocity.x = 0;
lander._angle = 0;
lander._position.y = ...;
```

Those properties are private implementation details inside `lander.js`.

Instead, the autopilot should call the public control methods.

This keeps the system testable and prevents the autopilot from becoming a second physics engine.

---

# 11. Autopilot Lifecycle

The autopilot exposes:

```js
{
    attachEventListeners,
    detachEventListeners
}
```

`attachEventListeners()` registers:

```js
document.addEventListener("keydown", toggleOnP);
```

`detachEventListeners()` removes it.

The toggle function is:

```js
const toggleOnP = ({ key }) => {
    if (key === "p") toggleOnOff();
};
```

### Tutorial behavior

The autopilot is not attached while the tutorial is active.

After the tutorial closes:

```js
autopilot.attachEventListeners();
```

This prevents `P` from functioning before the normal game controls are ready.

---

# 12. Relationship With Human Controls

Human controls are implemented separately in:

```text
lander/controls.js
```

The human controller calls the same lander methods as the autopilot.

For example:

```text
Human keyboard
     │
     ├── W / ArrowUp ──→ lander.engineOn()
     ├── A / ArrowLeft → lander.rotateLeft()
     └── D / ArrowRight → lander.rotateRight()

Autopilot
     │
     ├── controller decision ──→ lander.engineOn/off()
     └── attitude decision ────→ lander.rotateLeft/right()
```

This common API is important because it means the autopilot does not need to understand keyboard or touch input.

---

# 13. Touch Controls Are Independent

The mobile touch system has additional logic for:

- tracking each `Touch.identifier`
- multiple simultaneous fingers
- fingers moving between control zones
- reference-counting fingers in the same zone
- `touchcancel`
- clearing controls when listeners are detached

None of this is used by the autopilot.

The autopilot operates independently of touch state.

This means developers should avoid adding autopilot behavior to `controls.js` unless the goal is specifically to change the human-input system.

---

# 14. Autopilot and Game Over

There is an important lifecycle detail to be aware of.

When a game ends, `index.js` detaches the normal lander controls:

```js
landerControls.detachEventListeners();
```

but it does **not** explicitly call:

```js
autopilot.detachEventListeners();
```

The autopilot's animation callback may therefore continue to schedule itself while `running` remains true.

The lander's `engineOn()` method protects itself against game-end state, but this is still worth understanding when modifying game lifecycle behavior.

### Recommended future improvement

If autopilot should automatically stop at game over, explicitly add an autopilot shutdown path to the round lifecycle, for example:

```js
autopilot.off();
```

or expose a dedicated:

```js
autopilot.stop();
```

method.

That would also make the UI state unambiguous between rounds.

**Do not implement this change automatically without checking the desired gameplay behavior**, because persistent autopilot across rounds may currently be intentional.

---

# 15. Autopilot Does Not Know About Landing Zones

The terrain system exposes landing-surface information through:

```js
terrain.getLandingData()
```

which contains landing surface positions and widths.

However, `autopilot.js` never reads this information.

Therefore the autopilot does not deliberately steer toward:

```text
largeLandingSurface
smallLandingSurface
```

It only stabilizes the vehicle.

The lander's horizontal position wraps around the screen:

```js
_position.x = ((_position.x % canvasWidth) + canvasWidth) % canvasWidth;
```

The autopilot currently has no target X coordinate, so it cannot intentionally select which side of the world to land on.

---

# 16. Autopilot Does Not Detect Terrain Distance Directly

The controller's vertical target is based on:

```js
lander.getPosition().y
```

and a simple mathematical approximation:

```js
sqrt(max(0, y / 160))
```

It does **not** ask:

```js
terrain.getLandingData()
```

for the exact distance to the surface beneath the lander.

This is a major distinction.

The controller is altitude-based, not collision-prediction-based.

Terrain height can vary, and the actual landing surface can therefore differ from the autopilot's simple vertical-speed estimate.

---

# 17. Hoverslam Interaction

The game has explicit hoverslam detection in `helpers/scoring.js`.

A hoverslam requires, among other things:

```text
exactly one engine activation
+
engine held through touchdown
+
burn timing within the configured slack
```

The autopilot's engine logic can turn the engine on and off multiple times as it corrects the vehicle.

Therefore the autopilot is **not specifically designed to perform a hoverslam**.

If a future autopilot is intended to earn hoverslam consistently, it will need a dedicated descent/burn planner rather than the current reactive controller.

Relevant constants include:

```js
HOVERSLAM_SLACK_MS = 500;
HOVERSLAM_RELEASE_GRACE_MS = 100;
```

---

# 18. Physics Values Relevant to Autopilot Tuning

From `helpers/constants.js` and `lander.js`:

```text
Gravity:             0.0035
Main thrust:         0.012
Lander width:        20
Lander height:       40
Crash velocity:      0.6
Crash angle:         11°
Physics interval:    approximately 120 Hz
```

The thrust is therefore several times the gravity constant, meaning the engine is powerful enough to strongly change vertical motion.

This is one reason the autopilot uses an on/off engine instead of rapidly switching a throttle value.

---

# 19. Tuning the Autopilot

The most important tuning values currently live directly in `autopilot.js`.

## Attitude gain

```js
const targetAngularVelocity = -angleInTurns * 5;
```

The `5` controls how aggressively desired angular velocity responds to angle error.

Increasing it generally makes the controller demand stronger rotational correction.

Decreasing it generally makes the controller more conservative.

However, because the actual rotation acceleration is defined in `lander.js`, this value should be tuned together with:

```js
if (_rotatingRight) _rotationVelocity += ...
if (_rotatingLeft) _rotationVelocity -= ...
```

---

## Rotation deadband

```js
0.001
```

This determines when the controller stops correcting angular velocity.

A larger deadband can reduce tiny control oscillations.

A smaller deadband produces tighter correction but may cause more frequent switching.

---

## Horizontal velocity threshold

```js
Math.abs(lander.getVelocity().x) > 0.005
```

This prevents extremely small horizontal velocities from triggering horizontal correction.

---

## Death-spiral threshold

```js
Math.abs(lander.getRotationVelocity()) > 1
```

This defines what the autopilot considers an extreme rotational state.

---

## Upright tolerance

```js
Math.abs(angleInTurns) < 0.25
```

This corresponds to roughly ±90° around upright.

It is used when deciding whether normal vertical descent control should be applied.

---

## Vertical target formula

```js
Math.max(0, lander.getPosition().y / 160) ** 0.5
```

The divisor and square-root curve determine how quickly the allowed descent speed decreases as the lander approaches the ground.

This is one of the most important values to tune if landing reliability is being improved.

---

# 20. Recommended Development Workflow

When changing the autopilot:

### Step 1 — Change only `autopilot.js`

Start with controller behavior before modifying physics.

### Step 2 — Test attitude stabilization

Start with the lander at different initial angles and rotation velocities.

Check whether it converges toward upright without excessive oscillation.

### Step 3 — Test vertical descent

Check whether the engine engages early enough to prevent excessive touchdown speed.

### Step 4 — Test horizontal drift

Give the lander meaningful positive and negative X velocity.

Verify that the controller uses the engine's angled thrust to oppose drift.

### Step 5 — Test extreme rotation

Verify that the death-spiral recovery branch does not make normal situations unstable.

### Step 6 — Test round resets

Toggle autopilot on, crash/land, reset, and verify the desired autopilot state persists or resets as intended.

### Step 7 — Test mobile separately

Do not assume touch behavior is affected by autopilot changes. The two systems use different control paths.

---

# 21. Potential Future Autopilot Improvements

The current controller is intentionally simple. A more advanced autopilot could add:

## A. Landing-pad targeting

Read:

```js
terrain.getLandingData()
```

and select a target X coordinate.

Then calculate horizontal position error:

```text
targetX - currentX
```

and steer toward the chosen pad.

---

## B. Predictive landing

Instead of reacting only to current velocity, estimate:

```text
time to ground
predicted X at touchdown
predicted vertical velocity
predicted angle at touchdown
```

This would allow the controller to begin corrections earlier.

---

## C. Terrain-aware descent

Use the actual terrain height below the lander rather than the global altitude estimate.

This would make the vertical controller work better on irregular terrain.

---

## D. Controlled hoverslam

Create a dedicated state machine:

```text
COAST
  ↓
ALIGN
  ↓
WAIT_FOR_BURN
  ↓
BURN
  ↓
TOUCHDOWN
```

The burn should be deliberately timed rather than triggered reactively.

---

## E. Score optimization

A score-aware autopilot could optimize:

```text
landing speed
landing angle
bonus landing pad
height bonuses
speed bonuses
rotation bonuses
```

The current autopilot does none of this intentionally.

---

## F. Asteroid avoidance

The current controller has no asteroid awareness.

A future version could inspect active asteroid positions and add an avoidance layer above the normal flight controller.

---

# 22. Suggested Architecture for an Advanced Autopilot

If the autopilot becomes substantially more sophisticated, avoid putting everything into one `run()` function.

A cleaner design would be:

```text
Autopilot
│
├── attitudeController
│     └── keeps lander upright
│
├── horizontalController
│     └── targets landing X position
│
├── descentController
│     └── manages vertical speed
│
├── collisionController
│     └── terrain/asteroid prediction
│
└── maneuverController
      └── hoverslam / scoring strategies
```

Then the top-level loop combines those decisions into the existing lander control API.

This would make tuning and debugging much easier than expanding the current monolithic feedback loop.

---

# 23. Developer Contract for `makeAutopilot`

`makeAutopilot(lander)` expects a lander object implementing:

```js
getAngle()
getRotationVelocity()
getPosition()
getVelocity()

engineOn()
engineOff()

rotateLeft()
rotateRight()

stopLeftRotation()
stopRightRotation()
```

It also expects the DOM to contain:

```html
#autopilotStatus
```

The module returns:

```js
{
    attachEventListeners,
    detachEventListeners
}
```

No external packages are required.

---

# 24. Quick Reference

### Toggle

```text
P
```

### Reads

```text
angle
rotation velocity
X/Y position
X/Y velocity
```

### Controls

```text
main engine
left rotation
right rotation
```

### Controller goals

```text
1. Stabilize attitude
2. Reduce horizontal drift when possible
3. Reduce excessive descent speed near the ground
4. Recover from extreme rotation
```

### Does not currently handle

```text
landing-pad selection
terrain prediction
asteroid avoidance
shield activation
throttle
fuel
hoverslam planning
score optimization
```

---

# 25. Key Takeaway for Developers

The current autopilot should be understood as a **reactive flight stabilizer**, not an autonomous landing navigator.

Its strength is that it is small, dependency-free, and built entirely on the lander's existing control interface. It observes the current state and makes immediate control decisions every animation frame.

The most important code path is:

```text
lander state
    ↓
normalize angle
    ↓
calculate desired angular velocity
    ↓
correct rotation
    ↓
inspect horizontal velocity
    ↓
calculate altitude-based target descent speed
    ↓
choose engine ON/OFF
    ↓
repeat next animation frame
```

If you want to make the autopilot substantially better at **actually choosing where and when to land**, the next major architectural step is not simply changing the existing constants. It is adding **target selection + prediction + terrain awareness** while keeping the existing `lander` control API intact.

---

## Change-Safety Notes

When modifying this project:

- Keep physics changes in `lander/lander.js`.
- Keep automatic decision logic in `autopilot.js`.
- Keep human input logic in `lander/controls.js`.
- Prefer public lander methods over direct state mutation.
- Be careful with game-end/reset lifecycle behavior.
- Test keyboard, touch, tutorial, game-over, and reset states after control changes.
- Preserve existing comments and annotations when making targeted changes.
