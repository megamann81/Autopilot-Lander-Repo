const turnModulo = (angleInTurns) =>
  ((((angleInTurns + 0.5) % 1) + 1) % 1) - 0.5;
const ANGULAR_VELOCITY_MULTIPLIER = 5;
const ROTATION_TOLERANCE = 0.001;
const MIN_X_VELOCITY = 0.005;
const MAX_ROTATION_VELOCITY = 1;
const MAX_STABLE_ANGLE = 0.25;
const TARGET_VELOCITY_HEIGHT = 160;

export const makeAutopilot = (lander) => {
  let running = false;

  const controlRotation = () => {
    const angleInTurns = turnModulo(lander.getAngle() / (Math.PI * 2));
    const targetAngularVelocity =
      -angleInTurns * ANGULAR_VELOCITY_MULTIPLIER;
    const angularVelocityDiff =
      lander.getRotationVelocity() - targetAngularVelocity;
    const targetVelocity =
      Math.max(0, lander.getPosition().y / TARGET_VELOCITY_HEIGHT) ** 0.5;

    let engineFacingOppositeOfXVelocity = false;
    let deathSpiralRecovery = false;

    if (angularVelocityDiff < -ROTATION_TOLERANCE) {
      lander.stopLeftRotation();
      lander.rotateRight();
    } else if (angularVelocityDiff > ROTATION_TOLERANCE) {
      lander.stopRightRotation();
      lander.rotateLeft();
    } else {
      lander.stopLeftRotation();
      lander.stopRightRotation();
    }

    engineFacingOppositeOfXVelocity =
      Math.abs(lander.getVelocity().x) > MIN_X_VELOCITY &&
      lander.getVelocity().x > 0 !== angleInTurns > 0;

    if (Math.abs(lander.getRotationVelocity()) > MAX_ROTATION_VELOCITY) {
      engineFacingOppositeOfXVelocity = false;
      deathSpiralRecovery = Math.abs(angleInTurns) < MAX_STABLE_ANGLE;
    }

    if (
      deathSpiralRecovery ||
      engineFacingOppositeOfXVelocity ||
      (lander.getVelocity().y > targetVelocity &&
        Math.abs(angleInTurns) < MAX_STABLE_ANGLE)
    ) {
      lander.engineOn();
    } else {
      lander.engineOff();
    }
  };

  const controlDescent = () => {
    if (lander.getVelocity().y > 0.2) {
      lander.engineOn();
    } else {
      lander.engineOff();
    }
  };

  const run = () => {
    controlRotation();
    controlDescent();

    if (running) {
      window.requestAnimationFrame(run);
    }
  };

  const on = () => {
    running = true;
    window.requestAnimationFrame(run);
    document.querySelector("#autopilotStatus").textContent = "ON";
  };

  const off = () => {
    running = false;

    lander.engineOff();
    lander.stopLeftRotation();
    lander.stopRightRotation();

    document.querySelector("#autopilotStatus").textContent = "OFF";
  };

  const toggleOnOff = () => (running ? off() : on());

  const toggleOnP = ({ key }) => {
    if (key === "p") toggleOnOff();
  };

  const attachEventListeners = () => {
    document.addEventListener("keydown", toggleOnP);
  };

  const detachEventListeners = () => {
    document.removeEventListener("keydown", toggleOnP);
  };

  return { attachEventListeners, detachEventListeners };
};
