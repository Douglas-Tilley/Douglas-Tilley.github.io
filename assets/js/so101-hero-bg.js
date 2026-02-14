(function () {
  "use strict";

  var HERO_SELECTOR = ".js-robot-hero";
  var CONFIG_SELECTOR = ".js-robot-hero-config";
  var MAX_BOOT_RETRIES = 40;
  var CAD_STATUS_POLL_INTERVAL_MS = 120;
  var WARNED_KEYS = {};
  var ACTIVE_HERO_SESSION = null;
  var HERO_TOGGLE_LISTENER_BOUND = false;
  var HERO_BOOT_IN_PROGRESS = false;
  var HERO_POINTER_SUPPRESS_UNTIL_MS = 0;
  var POINTER_SUPPRESS_AFTER_TOGGLE_MS = 260;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function toRad(value) {
    return (Number(value) || 0) * (Math.PI / 180);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function invert3x3(matrix) {
    var a = matrix[0][0];
    var b = matrix[0][1];
    var c = matrix[0][2];
    var d = matrix[1][0];
    var e = matrix[1][1];
    var f = matrix[1][2];
    var g = matrix[2][0];
    var h = matrix[2][1];
    var i = matrix[2][2];

    var cofactor00 = e * i - f * h;
    var cofactor01 = -(d * i - f * g);
    var cofactor02 = d * h - e * g;
    var cofactor10 = -(b * i - c * h);
    var cofactor11 = a * i - c * g;
    var cofactor12 = -(a * h - b * g);
    var cofactor20 = b * f - c * e;
    var cofactor21 = -(a * f - c * d);
    var cofactor22 = a * e - b * d;

    var det = a * cofactor00 + b * cofactor01 + c * cofactor02;
    if (Math.abs(det) < 1e-9) {
      return null;
    }

    var invDet = 1 / det;
    return [
      [cofactor00 * invDet, cofactor10 * invDet, cofactor20 * invDet],
      [cofactor01 * invDet, cofactor11 * invDet, cofactor21 * invDet],
      [cofactor02 * invDet, cofactor12 * invDet, cofactor22 * invDet],
    ];
  }

  function matVec3(matrix, vector) {
    return [
      matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
      matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
      matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2],
    ];
  }

  function parseConfig(heroElement) {
    var configElement = heroElement.querySelector(CONFIG_SELECTOR);
    if (!configElement) {
      return null;
    }

    try {
      return JSON.parse(configElement.textContent);
    } catch (error) {
      warnOnce("config-parse", "Invalid SO101 hero config JSON. Falling back to static hero.");
      return null;
    }
  }

  function warnOnce(key, message, error) {
    if (WARNED_KEYS[key]) {
      return;
    }
    WARNED_KEYS[key] = true;

    if (!window.console || typeof window.console.warn !== "function") {
      return;
    }

    if (error) {
      window.console.warn("[so101-hero] " + message, error);
      return;
    }

    window.console.warn("[so101-hero] " + message);
  }

  function supportsWebGL() {
    try {
      var canvas = document.createElement("canvas");
      var context =
        canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      return Boolean(context);
    } catch (error) {
      return false;
    }
  }

  function areSiteAnimationsEnabled() {
    return !document.documentElement.classList.contains("animations-off");
  }

  function setHeroStaticState(hero) {
    if (!hero) {
      return;
    }
    hero.classList.remove("home-hero--robot-loading");
    hero.classList.remove("home-hero--robot-active");
    hero.classList.add("home-hero--robot-static");
  }

  function disposeActiveHeroSession() {
    if (!ACTIVE_HERO_SESSION || typeof ACTIVE_HERO_SESSION.dispose !== "function") {
      ACTIVE_HERO_SESSION = null;
      return;
    }
    ACTIVE_HERO_SESSION.dispose();
    ACTIVE_HERO_SESSION = null;
  }

  function suppressPointerInput(durationMs) {
    var duration = Number(durationMs);
    if (!isFinite(duration) || duration < 0) {
      duration = 0;
    }
    HERO_POINTER_SUPPRESS_UNTIL_MS = Date.now() + duration;
  }

  function bindHeroToggleListener() {
    if (HERO_TOGGLE_LISTENER_BOUND) {
      return;
    }
    HERO_TOGGLE_LISTENER_BOUND = true;

    document.addEventListener("site-animations-changed", function (event) {
      var enabled = !(event && event.detail && event.detail.enabled === false);
      var hero = document.querySelector(HERO_SELECTOR);
      if (!hero) {
        return;
      }

      if (!enabled) {
        HERO_BOOT_IN_PROGRESS = false;
        disposeActiveHeroSession();
        setHeroStaticState(hero);
        return;
      }

      suppressPointerInput(POINTER_SUPPRESS_AFTER_TOGGLE_MS);
      if (!ACTIVE_HERO_SESSION && !HERO_BOOT_IN_PROGRESS) {
        bootRobotHero(0);
      }
    });
  }

  function smoothTarget(current, target, alpha) {
    current[0] += (target[0] - current[0]) * alpha;
    current[1] += (target[1] - current[1]) * alpha;
    current[2] += (target[2] - current[2]) * alpha;
    return current;
  }

  function getIdleTarget(timeMs, base) {
    var bx = base && typeof base[0] === "number" ? base[0] : 0;
    var by = base && typeof base[1] === "number" ? base[1] : 0;
    var bz = base && typeof base[2] === "number" ? base[2] : 0;
    var t = (timeMs || 0) * 0.001;
    return [
      bx + 0.35 + Math.cos(t * 0.54) * 0.78,
      by + 1.0 + Math.sin(t * 0.64) * 0.4,
      bz + Math.sin(t * 0.46) * 0.72,
    ];
  }

  function getViewportRect() {
    return {
      left: 0,
      top: 0,
      width: Math.max(window.innerWidth || 1, 1),
      height: Math.max(window.innerHeight || 1, 1),
    };
  }

  function resolveInteractionConfig(config) {
    var interaction = config && config.interaction ? config.interaction : {};
    var legacyPlane = config && typeof config.mouse_plane_z === "number"
      ? Number(config.mouse_plane_z)
      : 0;
    var scopeRaw = String(interaction.scope || "hero").toLowerCase();
    var scope = scopeRaw;
    if (scope !== "hero" && scope !== "viewport" && scope !== "hybrid") {
      scope = "hero";
    }

    var heroWeight = Number(interaction.hero_weight);
    if (!isFinite(heroWeight)) {
      heroWeight = 1;
    }

    var globalWeight = Number(interaction.global_weight);
    if (!isFinite(globalWeight)) {
      globalWeight = 0.25;
    }

    var globalIdleDamping = Number(interaction.global_idle_damping);
    if (!isFinite(globalIdleDamping)) {
      globalIdleDamping = 0.92;
    }

    var mousePlaneZ = typeof interaction.mouse_plane_z === "number"
      ? Number(interaction.mouse_plane_z)
      : legacyPlane;
    var pointerPlaneMode = String(
      interaction.pointer_plane_mode || "camera"
    ).toLowerCase();
    if (
      pointerPlaneMode !== "camera" &&
      pointerPlaneMode !== "world_z" &&
      pointerPlaneMode !== "workspace"
    ) {
      pointerPlaneMode = "camera";
    }
    var pointerPlaneOffset = Number(interaction.pointer_plane_offset);
    if (!isFinite(pointerPlaneOffset)) {
      pointerPlaneOffset = 0;
    }

    return {
      scope: scope,
      heroWeight: clamp(heroWeight, 0, 1),
      globalWeight: clamp(globalWeight, 0, 1),
      globalIdleDamping: clamp(globalIdleDamping, 0.5, 0.995),
      mousePlaneZ: mousePlaneZ,
      pointerPlaneMode: pointerPlaneMode,
      pointerPlaneOffset: pointerPlaneOffset,
    };
  }

  function resolveGripperProximityConfig(config) {
    var gripper = config && config.gripper ? config.gripper : {};
    var enabled = gripper.enabled !== false;
    var closeDistance = Number(gripper.close_distance);
    if (!isFinite(closeDistance)) {
      closeDistance = 0.18;
    }
    var openDistance = Number(gripper.open_distance);
    if (!isFinite(openDistance)) {
      openDistance = 0.9;
    }
    if (openDistance <= closeDistance) {
      openDistance = closeDistance + 0.2;
    }

    var closedAngleDeg = Number(gripper.closed_angle_deg);
    if (!isFinite(closedAngleDeg)) {
      closedAngleDeg = -6;
    }
    var openAngleDeg = Number(gripper.open_angle_deg);
    if (!isFinite(openAngleDeg)) {
      openAngleDeg = 34;
    }

    var smoothing = Number(gripper.smoothing);
    if (!isFinite(smoothing)) {
      smoothing = 0.28;
    }

    return {
      enabled: enabled,
      closeDistance: Math.max(closeDistance, 0.001),
      openDistance: Math.max(openDistance, closeDistance + 0.001),
      closedAngle: toRad(closedAngleDeg),
      openAngle: toRad(openAngleDeg),
      smoothing: clamp(smoothing, 0.01, 1),
    };
  }

  function hasCadDependencies() {
    return Boolean(
      window.THREE &&
        typeof window.THREE.STLLoader === "function" &&
        typeof window.THREE.ColladaLoader === "function" &&
        typeof window.URDFLoader === "function"
    );
  }

  function createPointerTracker(hero) {
    var state = {
      clientX: 0,
      clientY: 0,
      insideHero: false,
      hasPointer: false,
    };

    function onPointerMove(event) {
      if (Date.now() < HERO_POINTER_SUPPRESS_UNTIL_MS) {
        state.hasPointer = false;
        state.insideHero = false;
        return;
      }

      state.clientX = event.clientX;
      state.clientY = event.clientY;
      state.hasPointer = true;

      var rect = hero.getBoundingClientRect();
      state.insideHero =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
    }

    function onPointerOut() {
      state.insideHero = false;
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerdown", onPointerMove);
    window.addEventListener("blur", onPointerOut);

    return {
      state: state,
      dispose: function () {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerdown", onPointerMove);
        window.removeEventListener("blur", onPointerOut);
      },
    };
  }

  function mapPointerToWorkspace(pointerRect, pointer, workspace, planeZ) {
    var width = Math.max(pointerRect.width || 1, 1);
    var height = Math.max(pointerRect.height || 1, 1);
    var nx = ((pointer.clientX - pointerRect.left) / width) * 2 - 1;
    var ny = -((pointer.clientY - pointerRect.top) / height) * 2 + 1;

    var xMin =
      workspace && typeof workspace.min_x === "number" ? workspace.min_x : -2.4;
    var xMax =
      workspace && typeof workspace.max_x === "number" ? workspace.max_x : 2.4;
    var yMin =
      workspace && typeof workspace.min_y === "number" ? workspace.min_y : 0.2;
    var yMax =
      workspace && typeof workspace.max_y === "number" ? workspace.max_y : 2.4;
    var zMin =
      workspace && typeof workspace.min_z === "number" ? workspace.min_z : -2.0;
    var zMax =
      workspace && typeof workspace.max_z === "number" ? workspace.max_z : 2.0;

    var x = lerp(xMin, xMax, (nx + 1) * 0.5);
    var y = lerp(yMin, yMax, (ny + 1) * 0.5);
    var zDefault = lerp(zMax, zMin, (nx + 1) * 0.5);
    var z =
      typeof planeZ === "number" ? clamp(planeZ, zMin, zMax) : zDefault;

    return [x, y, z];
  }

  function createSoftwareRenderer(hero, layer, config, pointerTracker) {
    var canvas = document.createElement("canvas");
    canvas.className = "home-hero__robot-canvas home-hero__robot-canvas--software";
    canvas.setAttribute("aria-hidden", "true");
    layer.appendChild(canvas);

    var ctx = canvas.getContext("2d");
    var disposed = false;
    var rafHandle = null;

    var chain = window.SO101IK.createChain(config);
    var ikConfig = config.ik || {};
    var workspace = config.workspace || {};
    var smoothing = Number(ikConfig.target_smoothing) || 0.22;
    var interaction = resolveInteractionConfig(config);
    var theme = config.theme || {};

    var targetCurrent = [0.45, 1.05, 0];
    var targetRaw = [0.45, 1.05, 0];
    var targetClamped = [0.45, 1.05, 0];

    function setSize() {
      var rect = layer.getBoundingClientRect();
      var width = Math.max(Math.floor(rect.width), 1);
      var height = Math.max(Math.floor(rect.height), 1);
      var dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function project(point, width, height) {
      var cameraDistance = 3.3;
      var px = point[0];
      var py = point[1];
      var pz = point[2];
      var depth = cameraDistance - pz;
      var scale = 175 / Math.max(depth, 0.4);

      return {
        x: width * 0.5 + px * scale,
        y: height * 0.88 - py * scale,
        scale: scale,
        depth: depth,
      };
    }

    function drawScene(fk, target) {
      var width = canvas.clientWidth;
      var height = canvas.clientHeight;
      var i;

      ctx.clearRect(0, 0, width, height);

      var baseGlow = ctx.createRadialGradient(
        width * 0.18,
        height * 0.85,
        10,
        width * 0.18,
        height * 0.85,
        width * 0.45
      );
      baseGlow.addColorStop(0, "rgba(92, 161, 255, 0.24)");
      baseGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = baseGlow;
      ctx.fillRect(0, 0, width, height);

      var projectedSegments = fk.segments.map(function (segment) {
        var p0 = project(segment[0], width, height);
        var p1 = project(segment[1], width, height);
        return {
          p0: p0,
          p1: p1,
          avgDepth: (p0.depth + p1.depth) * 0.5,
        };
      });

      projectedSegments.sort(function (a, b) {
        return b.avgDepth - a.avgDepth;
      });

      var linkStroke = theme.link || "#f0f3fb";
      var edgeStroke = "rgba(19, 34, 58, 0.88)";
      for (i = 0; i < projectedSegments.length; i += 1) {
        var seg = projectedSegments[i];
        var widthScale = clamp((seg.p0.scale + seg.p1.scale) * 0.034, 5, 18);

        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        ctx.strokeStyle = edgeStroke;
        ctx.lineWidth = widthScale + 5;
        ctx.beginPath();
        ctx.moveTo(seg.p0.x, seg.p0.y);
        ctx.lineTo(seg.p1.x, seg.p1.y);
        ctx.stroke();

        ctx.strokeStyle = linkStroke;
        ctx.lineWidth = widthScale;
        ctx.beginPath();
        ctx.moveTo(seg.p0.x, seg.p0.y);
        ctx.lineTo(seg.p1.x, seg.p1.y);
        ctx.stroke();
      }

      var jointColor = theme.joint || "#ff934d";
      for (i = 0; i < fk.jointPositions.length; i += 1) {
        var joint = project(fk.jointPositions[i], width, height);
        var radius = clamp(joint.scale * 0.044, 3.5, 9);
        ctx.fillStyle = "rgba(15, 26, 44, 0.92)";
        ctx.beginPath();
        ctx.arc(joint.x, joint.y, radius + 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = jointColor;
        ctx.beginPath();
        ctx.arc(joint.x, joint.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      var endStart = project(fk.segments[3][0], width, height);
      var endEff = project(fk.endEffector, width, height);
      var dx = endEff.x - endStart.x;
      var dy = endEff.y - endStart.y;
      var mag = Math.max(Math.hypot(dx, dy), 1e-6);
      var ux = dx / mag;
      var uy = dy / mag;
      var px = -uy;
      var py = ux;
      var jawGap = 7;
      var jawLen = 17;

      ctx.strokeStyle = "rgba(16, 27, 44, 0.9)";
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(endEff.x + px * jawGap, endEff.y + py * jawGap);
      ctx.lineTo(
        endEff.x + px * jawGap + ux * jawLen,
        endEff.y + py * jawGap + uy * jawLen
      );
      ctx.moveTo(endEff.x - px * jawGap, endEff.y - py * jawGap);
      ctx.lineTo(
        endEff.x - px * jawGap + ux * jawLen,
        endEff.y - py * jawGap + uy * jawLen
      );
      ctx.stroke();

      var targetPoint = project(target, width, height);
      ctx.fillStyle = theme.target || "#3fd5ff";
      ctx.beginPath();
      ctx.arc(targetPoint.x, targetPoint.y, 4.2, 0, Math.PI * 2);
      ctx.fill();
    }

    function animate(timeMs) {
      if (disposed) {
        return;
      }

      var pointer = pointerTracker.state;
      var idleTarget = getIdleTarget(timeMs, chain.base);
      var pointerTarget = null;

      if (pointer.hasPointer) {
        var heroRect = hero.getBoundingClientRect();
        if (interaction.scope === "hero") {
          if (pointer.insideHero) {
            pointerTarget = mapPointerToWorkspace(
              heroRect,
              pointer,
              workspace,
              interaction.mousePlaneZ
            );
          }
        } else {
          pointerTarget = mapPointerToWorkspace(
            getViewportRect(),
            pointer,
            workspace,
            interaction.mousePlaneZ
          );
        }
      }

      targetRaw = pointerTarget || idleTarget;

      smoothTarget(targetCurrent, targetRaw, smoothing);
      targetClamped = window.SO101IK.clampTarget(
        targetCurrent,
        workspace,
        chain.base
      );

      var desiredAngles = window.SO101IK.solveSOPositionIK(
        chain,
        targetClamped,
        ikConfig
      );
      var jointSmoothing = Number(ikConfig.joint_smoothing) || 0.24;
      var i;
      for (i = 0; i < chain.angles.length; i += 1) {
        chain.angles[i] += (desiredAngles[i] - chain.angles[i]) * jointSmoothing;
        chain.angles[i] = clamp(
          chain.angles[i],
          chain.limits[i][0],
          chain.limits[i][1]
        );
      }

      var refineIterations = Number(ikConfig.refine_iterations) || 0;
      if (refineIterations > 0) {
        window.SO101IK.solveDLSIK(chain, targetClamped, {
          iterations: refineIterations,
          damping: Number(ikConfig.refine_damping) || 0.16,
          epsilon: Number(ikConfig.epsilon) || 0.005,
          max_step_deg: Number(ikConfig.refine_max_step_deg) || 4.0,
        });
      }

      var fk = window.SO101IK.forwardKinematics(chain);
      drawScene(fk, targetRaw);
      rafHandle = window.requestAnimationFrame(animate);
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (rafHandle) {
        window.cancelAnimationFrame(rafHandle);
      }
      window.removeEventListener("resize", setSize);
      if (canvas.parentNode) {
        canvas.parentNode.removeChild(canvas);
      }
    }

    window.addEventListener("resize", setSize);
    setSize();
    animate(0);

    return {
      dispose: dispose,
    };
  }

  function addLights(scene) {
    var ambient = new THREE.AmbientLight(0xc8d7ff, 0.55);
    var key = new THREE.DirectionalLight(0xdff5ff, 0.8);
    var rim = new THREE.DirectionalLight(0x88a7ff, 0.35);

    key.position.set(2.5, 3.2, 2.4);
    rim.position.set(-2.2, 1.8, -1.6);

    scene.add(ambient);
    scene.add(key);
    scene.add(rim);
  }

  function createPrimitiveRobotVisual(scene, theme) {
    var colors = theme || {};
    var linkColor = colors.link || "#f0f3fb";
    var jointColor = colors.joint || "#ff934d";
    var effectorColor = colors.effector || "#1a2638";
    var targetColor = colors.target || "#3fd5ff";

    var group = new THREE.Group();
    scene.add(group);

    var linkMaterial = new THREE.MeshStandardMaterial({
      color: linkColor,
      roughness: 0.46,
      metalness: 0.16,
    });

    var jointMaterial = new THREE.MeshStandardMaterial({
      color: jointColor,
      roughness: 0.38,
      metalness: 0.22,
    });

    var housingMaterial = new THREE.MeshStandardMaterial({
      color: 0x1f2f49,
      roughness: 0.5,
      metalness: 0.12,
    });

    var effectorMaterial = new THREE.MeshStandardMaterial({
      color: effectorColor,
      roughness: 0.48,
      metalness: 0.18,
    });

    var segmentSpecs = [
      { width: 0.2, depth: 0.18 },
      { width: 0.17, depth: 0.15 },
      { width: 0.14, depth: 0.12 },
      { width: 0.11, depth: 0.1 },
    ];

    var segmentMeshes = segmentSpecs.map(function (spec) {
      var geometry = new THREE.BoxGeometry(spec.width, 1, spec.depth);
      var mesh = new THREE.Mesh(geometry, linkMaterial);
      group.add(mesh);
      return mesh;
    });

    var basePlate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.28, 0.12, 24),
      new THREE.MeshStandardMaterial({
        color: 0x111c2f,
        roughness: 0.62,
        metalness: 0.2,
      })
    );
    basePlate.position.set(0, -0.06, 0);
    group.add(basePlate);

    var shoulderHousing = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.16, 0.25),
      housingMaterial
    );
    shoulderHousing.position.set(0, 0.07, 0);
    group.add(shoulderHousing);

    var jointMeshes = [
      new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.085, 24), jointMaterial),
      new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.08, 24), jointMaterial),
      new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.078, 0.074, 20), jointMaterial),
      new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.068, 0.07, 18), jointMaterial),
    ];

    jointMeshes.forEach(function (mesh) {
      mesh.rotation.x = Math.PI * 0.5;
      group.add(mesh);
    });

    var servoMeshes = [
      new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.18), housingMaterial),
      new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.11, 0.16), housingMaterial),
      new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.1, 0.14), housingMaterial),
    ];
    servoMeshes.forEach(function (mesh) {
      group.add(mesh);
    });

    var gripperGroup = new THREE.Group();
    var gripperPalm = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.08, 0.12),
      effectorMaterial
    );
    var fingerLeft = new THREE.Mesh(
      new THREE.BoxGeometry(0.025, 0.12, 0.03),
      jointMaterial
    );
    var fingerRight = new THREE.Mesh(
      new THREE.BoxGeometry(0.025, 0.12, 0.03),
      jointMaterial
    );
    fingerLeft.position.set(-0.03, 0.08, 0);
    fingerRight.position.set(0.03, 0.08, 0);
    gripperGroup.add(gripperPalm);
    gripperGroup.add(fingerLeft);
    gripperGroup.add(fingerRight);
    group.add(gripperGroup);

    var targetMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 16, 16),
      new THREE.MeshStandardMaterial({
        color: targetColor,
        emissive: targetColor,
        emissiveIntensity: 0.28,
        roughness: 0.18,
        metalness: 0.3,
      })
    );
    group.add(targetMarker);

    return {
      mode: "primitive",
      group: group,
      segmentMeshes: segmentMeshes,
      jointMeshes: jointMeshes,
      servoMeshes: servoMeshes,
      gripperGroup: gripperGroup,
      targetMarker: targetMarker,
      dispose: function () {
        group.traverse(function (node) {
          if (!node.isMesh) {
            return;
          }
          if (node.geometry && typeof node.geometry.dispose === "function") {
            node.geometry.dispose();
          }
          if (node.material && typeof node.material.dispose === "function") {
            node.material.dispose();
          }
        });
        if (group.parent) {
          group.parent.remove(group);
        }
      },
    };
  }

  function disposeObjectTree(root) {
    if (!root || typeof root.traverse !== "function") {
      return;
    }

    root.traverse(function (node) {
      if (!node.isMesh) {
        return;
      }

      if (node.geometry && typeof node.geometry.dispose === "function") {
        node.geometry.dispose();
      }

      if (Array.isArray(node.material)) {
        node.material.forEach(function (material) {
          if (material && typeof material.dispose === "function") {
            material.dispose();
          }
        });
      } else if (node.material && typeof node.material.dispose === "function") {
        node.material.dispose();
      }
    });
  }

  function createThreeRobotVisual(scene, config) {
    var theme = (config && config.theme) || {};
    var modelConfig = (config && config.model) || {};
    var allowPrimitiveFallback = Boolean(config && config.debug_allow_primitive_fallback);
    var proxy = {
      mode: "proxy",
      active: allowPrimitiveFallback ? createPrimitiveRobotVisual(scene, theme) : null,
      cadReady: false,
      cadFailed: false,
      cadError: null,
      dispose: function () {
        if (this.active && typeof this.active.dispose === "function") {
          this.active.dispose();
        }
      },
    };

    if (!Boolean(modelConfig.use_cad)) {
      proxy.cadFailed = true;
      proxy.cadError = new Error("CAD mode is disabled in config.");
      return proxy;
    }

    if (!hasCadDependencies()) {
      proxy.cadFailed = true;
      proxy.cadError = new Error("Missing Three.js CAD dependencies.");
      return proxy;
    }

    var urdfPath = modelConfig.urdf || "/assets/models/so101/so101_new_calib.urdf";
    var loader = new window.URDFLoader();
    loader.packages = "";
    loader.parseVisual = true;
    loader.parseCollision = false;

    loader.load(
      urdfPath,
      function (robot) {
        if (!robot || !robot.joints) {
          proxy.cadFailed = true;
          proxy.cadError = new Error("URDF loaded without joints.");
          return;
        }

        var rootRotation = Array.isArray(modelConfig.root_rotation_deg)
          ? modelConfig.root_rotation_deg
          : [-90, 0, 180];
        var rootPosition = Array.isArray(modelConfig.root_position)
          ? modelConfig.root_position
          : [0, 0, 0];
        var scale = Number(modelConfig.scale) || 7.8;

        robot.rotation.set(
          toRad(rootRotation[0]),
          toRad(rootRotation[1]),
          toRad(rootRotation[2])
        );
        robot.position.set(
          Number(rootPosition[0]) || 0,
          Number(rootPosition[1]) || 0,
          Number(rootPosition[2]) || 0
        );
        robot.scale.setScalar(scale);

        robot.traverse(function (node) {
          if (!node.isMesh) {
            return;
          }

          if (!node.material) {
            node.material = new THREE.MeshStandardMaterial({
              color: 0xf0f3fb,
              roughness: 0.56,
              metalness: 0.12,
            });
          } else {
            node.material.roughness = 0.56;
            node.material.metalness = 0.18;
            node.material.needsUpdate = true;
          }

          node.castShadow = false;
          node.receiveShadow = true;
        });

        var cadGroup = new THREE.Group();
        cadGroup.add(robot);

        var targetColor = theme.target || "#3fd5ff";
        var targetMarker = new THREE.Mesh(
          new THREE.SphereGeometry(0.06, 16, 16),
          new THREE.MeshStandardMaterial({
            color: targetColor,
            emissive: targetColor,
            emissiveIntensity: 0.3,
            roughness: 0.2,
            metalness: 0.28,
          })
        );
        cadGroup.add(targetMarker);
        scene.add(cadGroup);

        var jointNamesConfig = modelConfig.joint_names || {};
        var jointNames = [
          jointNamesConfig.yaw || "shoulder_pan",
          jointNamesConfig.shoulder || "shoulder_lift",
          jointNamesConfig.elbow || "elbow_flex",
          jointNamesConfig.wrist || "wrist_flex",
        ];
        var gripperJointName =
          jointNamesConfig.gripper ||
          modelConfig.gripper_joint_name ||
          modelConfig.gripper_joint ||
          "gripper";

        var signValues = Array.isArray(modelConfig.joint_signs)
          ? modelConfig.joint_signs.slice(0, 4)
          : [1, -1, -1, -1];
        while (signValues.length < 4) {
          signValues.push(1);
        }
        var jointSigns = signValues.map(function (value) {
          var sign = Number(value);
          return sign === 0 ? 1 : sign;
        });

        var offsetValues = Array.isArray(modelConfig.joint_offsets_deg)
          ? modelConfig.joint_offsets_deg.slice(0, 4)
          : [0, 14, -8, 0];
        while (offsetValues.length < 4) {
          offsetValues.push(0);
        }
        var jointOffsets = offsetValues.map(function (value) {
          return toRad(value);
        });

        var cadVisual = {
          mode: "cad",
          group: cadGroup,
          robot: robot,
          targetMarker: targetMarker,
          jointNames: jointNames,
          jointSigns: jointSigns,
          jointOffsets: jointOffsets,
          ikMode: String(modelConfig.ik_mode || "urdf").toLowerCase(),
          effectorFrameName:
            (jointNamesConfig && jointNamesConfig.effector_frame) ||
            modelConfig.effector_frame ||
            "gripper_frame_link",
          gripperJointName: gripperJointName,
          dispose: function () {
            disposeObjectTree(cadGroup);
            if (cadGroup.parent) {
              cadGroup.parent.remove(cadGroup);
            }
          },
        };

        if (proxy.active && typeof proxy.active.dispose === "function") {
          proxy.active.dispose();
        }

        proxy.active = cadVisual;
        proxy.cadReady = true;
        proxy.cadFailed = false;
        proxy.cadError = null;
      },
      null,
      function (error) {
        proxy.cadFailed = true;
        proxy.cadError = error || new Error("Failed to load CAD URDF.");
      }
    );

    return proxy;
  }

  function placeSegment(mesh, start, end) {
    var startVec = new THREE.Vector3(start[0], start[1], start[2]);
    var endVec = new THREE.Vector3(end[0], end[1], end[2]);
    var direction = endVec.clone().sub(startVec);
    var segmentLength = direction.length();
    if (segmentLength < 1e-5) {
      return;
    }

    direction.normalize();
    mesh.position.copy(startVec.add(endVec).multiplyScalar(0.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    mesh.scale.set(1, segmentLength, 1);
  }

  function setThreeRobotFromFK(visual, fk, target, chainAngles) {
    var activeVisual = visual && visual.active ? visual.active : visual;
    if (!activeVisual) {
      return;
    }

    if (activeVisual.mode === "proxy") {
      return;
    }

    if (activeVisual.mode === "cad") {
      if (activeVisual.ikMode === "urdf") {
        if (activeVisual.targetMarker) {
          activeVisual.targetMarker.position.set(target[0], target[1], target[2]);
        }
        return;
      }

      var angles = Array.isArray(chainAngles) ? chainAngles : [0, 0, 0, 0];
      var i;
      for (i = 0; i < 4; i += 1) {
        var jointName = activeVisual.jointNames[i];
        if (!jointName) {
          continue;
        }

        var sign = activeVisual.jointSigns[i] || 1;
        var offset = activeVisual.jointOffsets[i] || 0;
        var angle = (angles[i] || 0) * sign + offset;
        activeVisual.robot.setJointValue(jointName, angle);
      }

      if (activeVisual.targetMarker) {
        activeVisual.targetMarker.position.set(target[0], target[1], target[2]);
      }
      return;
    }

    var j;
    for (j = 0; j < fk.segments.length; j += 1) {
      placeSegment(
        activeVisual.segmentMeshes[j],
        fk.segments[j][0],
        fk.segments[j][1]
      );
    }

    for (j = 0; j < fk.jointPositions.length; j += 1) {
      activeVisual.jointMeshes[j].position.set(
        fk.jointPositions[j][0],
        fk.jointPositions[j][1],
        fk.jointPositions[j][2]
      );
    }

    if (activeVisual.servoMeshes && activeVisual.servoMeshes.length >= 3) {
      var s0 = fk.jointPositions[1];
      var s1 = fk.jointPositions[2];
      var s2 = fk.jointPositions[3];
      activeVisual.servoMeshes[0].position.set(s0[0], s0[1] + 0.02, s0[2]);
      activeVisual.servoMeshes[1].position.set(s1[0], s1[1] + 0.02, s1[2]);
      activeVisual.servoMeshes[2].position.set(s2[0], s2[1] + 0.018, s2[2]);
    }

    var endSegment = fk.segments[fk.segments.length - 1];
    var endStart = new THREE.Vector3(
      endSegment[0][0],
      endSegment[0][1],
      endSegment[0][2]
    );
    var endEnd = new THREE.Vector3(
      endSegment[1][0],
      endSegment[1][1],
      endSegment[1][2]
    );
    var endDir = endEnd.clone().sub(endStart);
    if (endDir.lengthSq() > 1e-9) {
      endDir.normalize();
      activeVisual.gripperGroup.position.copy(endEnd);
      activeVisual.gripperGroup.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        endDir
      );
    }

    if (activeVisual.targetMarker) {
      activeVisual.targetMarker.position.set(target[0], target[1], target[2]);
    }
  }

  function createCadFrameTransform(config) {
    var modelConfig = (config && config.model) || {};
    var rootRotation = Array.isArray(modelConfig.root_rotation_deg)
      ? modelConfig.root_rotation_deg
      : [-90, 0, 180];
    var rootPosition = Array.isArray(modelConfig.root_position)
      ? modelConfig.root_position
      : [0, 0, 0];

    var position = new THREE.Vector3(
      Number(rootPosition[0]) || 0,
      Number(rootPosition[1]) || 0,
      Number(rootPosition[2]) || 0
    );
    var quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        toRad(rootRotation[0]),
        toRad(rootRotation[1]),
        toRad(rootRotation[2]),
        "XYZ"
      )
    );
    var inverseQuaternion = quaternion.clone().conjugate();

    return {
      position: position,
      quaternion: quaternion,
      inverseQuaternion: inverseQuaternion,
    };
  }

  function localPointToWorld(localPoint, transform) {
    if (!transform) {
      return [localPoint[0], localPoint[1], localPoint[2]];
    }

    var vec = new THREE.Vector3(localPoint[0], localPoint[1], localPoint[2]);
    vec.applyQuaternion(transform.quaternion);
    vec.add(transform.position);
    return [vec.x, vec.y, vec.z];
  }

  function worldPointToLocal(worldPoint, transform) {
    if (!transform) {
      return [worldPoint[0], worldPoint[1], worldPoint[2]];
    }

    var vec = new THREE.Vector3(worldPoint[0], worldPoint[1], worldPoint[2]);
    vec.sub(transform.position);
    vec.applyQuaternion(transform.inverseQuaternion);
    return [vec.x, vec.y, vec.z];
  }

  function getCadEffectorObject(cadVisual) {
    if (!cadVisual || !cadVisual.robot) {
      return null;
    }

    if (cadVisual.effectorObject) {
      return cadVisual.effectorObject;
    }

    var robot = cadVisual.robot;
    var preferredName = cadVisual.effectorFrameName || "gripper_frame_link";
    cadVisual.effectorObject =
      (robot.links && robot.links[preferredName]) ||
      (robot.links && robot.links.gripper_frame_link) ||
      (robot.links && robot.links.gripper_link) ||
      robot;
    return cadVisual.effectorObject;
  }

  function enforceCadJointGuards(values, options) {
    var guarded = values.slice(0);
    if (!options || options.self_collision_guard === false) {
      return guarded;
    }

    var preferredSign = Number(options.elbow_preferred_sign);
    preferredSign = preferredSign >= 0 ? 1 : -1;
    var elbowMinAbs = toRad(
      typeof options.elbow_min_abs_deg === "number" ? options.elbow_min_abs_deg : 18
    );

    if (guarded.length > 2 && isFinite(guarded[2])) {
      if (guarded[2] * preferredSign < elbowMinAbs) {
        guarded[2] = preferredSign * elbowMinAbs;
      }
    }

    return guarded;
  }

  function solveCadURDFPositionIK(cadVisual, targetWorld, options) {
    if (!cadVisual || !cadVisual.robot || !Array.isArray(cadVisual.jointNames)) {
      return;
    }

    var robot = cadVisual.robot;
    var effector = getCadEffectorObject(cadVisual);
    if (!effector) {
      return;
    }

    var iterations = Math.max(1, Math.floor(Number(options.urdf_iterations) || 32));
    var damping = Number(options.urdf_damping);
    if (!isFinite(damping)) {
      damping = Number(options.damping);
    }
    if (!isFinite(damping)) {
      damping = 0.14;
    }

    var epsilon = Number(options.urdf_epsilon);
    if (!isFinite(epsilon)) {
      epsilon = Number(options.epsilon);
    }
    if (!isFinite(epsilon)) {
      epsilon = 0.02;
    }

    var maxStepDeg = Number(options.urdf_max_step_deg);
    if (!isFinite(maxStepDeg)) {
      maxStepDeg = Number(options.max_step_deg);
    }
    if (!isFinite(maxStepDeg)) {
      maxStepDeg = 8;
    }
    var maxStep = toRad(maxStepDeg);

    var targetVec = new THREE.Vector3(targetWorld[0], targetWorld[1], targetWorld[2]);
    var effectorVec = new THREE.Vector3();
    var jointPos = new THREE.Vector3();
    var axisWorld = new THREE.Vector3();
    var lever = new THREE.Vector3();
    var colVec = new THREE.Vector3();
    var errorVec = new THREE.Vector3();

    var iter;
    for (iter = 0; iter < iterations; iter += 1) {
      robot.updateMatrixWorld(true);
      effector.getWorldPosition(effectorVec);
      errorVec.copy(targetVec).sub(effectorVec);
      if (errorVec.length() < epsilon) {
        break;
      }

      var columns = [];
      var jointObjects = [];
      var j;
      for (j = 0; j < cadVisual.jointNames.length; j += 1) {
        var jointName = cadVisual.jointNames[j];
        var joint = robot.joints && robot.joints[jointName] ? robot.joints[jointName] : null;
        if (!joint) {
          continue;
        }

        joint.getWorldPosition(jointPos);
        axisWorld.copy(joint.axis || new THREE.Vector3(0, 0, 1));
        axisWorld.transformDirection(joint.matrixWorld).normalize();
        lever.copy(effectorVec).sub(jointPos);
        colVec.copy(axisWorld).cross(lever);
        columns.push([colVec.x, colVec.y, colVec.z]);
        jointObjects.push(joint);
      }

      if (!columns.length) {
        break;
      }

      var jjt = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      var c;
      var row;
      var col;
      for (c = 0; c < columns.length; c += 1) {
        for (row = 0; row < 3; row += 1) {
          for (col = 0; col < 3; col += 1) {
            jjt[row][col] += columns[c][row] * columns[c][col];
          }
        }
      }

      jjt[0][0] += damping * damping;
      jjt[1][1] += damping * damping;
      jjt[2][2] += damping * damping;

      var inv = invert3x3(jjt);
      if (!inv) {
        break;
      }

      var projected = matVec3(inv, [errorVec.x, errorVec.y, errorVec.z]);
      var nextAngles = [];
      for (j = 0; j < jointObjects.length; j += 1) {
        var current = Number(jointObjects[j].jointValue && jointObjects[j].jointValue[0]) || 0;
        var delta =
          columns[j][0] * projected[0] +
          columns[j][1] * projected[1] +
          columns[j][2] * projected[2];
        delta = clamp(delta, -maxStep, maxStep);
        nextAngles.push(current + delta);
      }

      nextAngles = enforceCadJointGuards(nextAngles, options || {});

      for (j = 0; j < jointObjects.length; j += 1) {
        robot.setJointValue(jointObjects[j].urdfName || cadVisual.jointNames[j], nextAngles[j]);
      }
    }
  }

  function updateCadGripperFromProximity(cadVisual, targetWorld, proximityConfig, state) {
    if (
      !cadVisual ||
      !cadVisual.robot ||
      !proximityConfig ||
      !proximityConfig.enabled
    ) {
      return;
    }

    var robot = cadVisual.robot;
    var effector = getCadEffectorObject(cadVisual);
    if (!effector) {
      return;
    }

    robot.updateMatrixWorld(true);
    var effectorPos = new THREE.Vector3();
    effector.getWorldPosition(effectorPos);
    var targetVec = new THREE.Vector3(targetWorld[0], targetWorld[1], targetWorld[2]);
    var distance = effectorPos.distanceTo(targetVec);

    var ratio = (distance - proximityConfig.closeDistance) /
      (proximityConfig.openDistance - proximityConfig.closeDistance);
    ratio = clamp(ratio, 0, 1);
    var closeTarget = 1 - ratio;

    if (!state) {
      return;
    }

    if (typeof state.current !== "number") {
      state.current = closeTarget;
    } else {
      state.current += (closeTarget - state.current) * proximityConfig.smoothing;
    }

    var gripperJoint = cadVisual.gripperJointName || "gripper";
    var gripperAngle = lerp(
      proximityConfig.openAngle,
      proximityConfig.closedAngle,
      state.current
    );

    var didSet = robot.setJointValue(gripperJoint, gripperAngle);
    if (!didSet) {
      warnOnce(
        "gripper-joint-missing",
        "Gripper proximity control enabled but joint '" + gripperJoint + "' was not found."
      );
    }
  }

  function mapPointerToWorldPlane(
    camera,
    pointerRect,
    pointer,
    interaction,
    cameraLookAt
  ) {
    var width = Math.max(pointerRect.width || 1, 1);
    var height = Math.max(pointerRect.height || 1, 1);
    var ndcX = ((pointer.clientX - pointerRect.left) / width) * 2 - 1;
    var ndcY = -((pointer.clientY - pointerRect.top) / height) * 2 + 1;

    var near = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera);
    var direction = near.sub(camera.position).normalize();
    var planeNormal = new THREE.Vector3();
    var planePoint;

    if (interaction.pointerPlaneMode === "world_z") {
      planeNormal.set(0, 0, 1);
      planePoint = new THREE.Vector3(0, 0, interaction.mousePlaneZ);
    } else {
      camera.getWorldDirection(planeNormal);
      planePoint = new THREE.Vector3(
        cameraLookAt[0],
        cameraLookAt[1],
        cameraLookAt[2]
      );
      if (interaction.pointerPlaneOffset !== 0) {
        planePoint.addScaledVector(planeNormal, interaction.pointerPlaneOffset);
      }
    }

    var denom = direction.dot(planeNormal);
    if (Math.abs(denom) < 1e-6) {
      return [planePoint.x, planePoint.y, planePoint.z];
    }

    var t = planePoint.clone().sub(camera.position).dot(planeNormal) / denom;
    if (!isFinite(t)) {
      return [planePoint.x, planePoint.y, planePoint.z];
    }
    if (t < 0) {
      t = 0;
    }

    var hit = camera.position.clone().add(direction.multiplyScalar(t));
    return [hit.x, hit.y, hit.z];
  }

  function createThreeRenderer(hero, layer, config, pointerTracker) {
    var renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = "home-hero__robot-canvas";
    renderer.domElement.setAttribute("aria-hidden", "true");
    layer.appendChild(renderer.domElement);

    var scene = new THREE.Scene();
    var cameraConfig = config.camera || {};
    var position = cameraConfig.position || [1.2, 1.05, 3.1];
    var lookAt = cameraConfig.look_at || [0.45, 0.85, 0];
    var camera = new THREE.PerspectiveCamera(
      Number(cameraConfig.fov) || 38,
      1,
      Number(cameraConfig.near) || 0.1,
      Number(cameraConfig.far) || 20
    );
    camera.position.set(position[0], position[1], position[2]);
    camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);

    addLights(scene);

    var visual = createThreeRobotVisual(scene, config);
    var chain = window.SO101IK.createChain(config);
    var useCadModel = Boolean(config && config.model && config.model.use_cad);
    var cadTransform = useCadModel ? createCadFrameTransform(config) : null;
    if (useCadModel) {
      chain.base = [0, 0, 0];
    }
    var ikConfig = config.ik || {};
    var workspace = config.workspace || {};
    var interaction = resolveInteractionConfig(config);
    var gripperProximity = resolveGripperProximityConfig(config);
    var smoothing = Number(ikConfig.target_smoothing) || 0.22;

    var targetCurrent = [0.45, 1.08, 0];
    var targetRaw = [0.45, 1.08, 0];
    var targetClamped = [0.45, 1.08, 0];
    var gripperState = { current: null };
    var jointSmoothing = Number(ikConfig.joint_smoothing) || 0.24;
    var disposed = false;
    var rafHandle = null;

    function setSize() {
      var rect = layer.getBoundingClientRect();
      var width = Math.max(rect.width, 1);
      var height = Math.max(rect.height, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }

    function onResize() {
      setSize();
    }

    function animate(timeMs) {
      if (disposed) {
        return;
      }

      var pointer = pointerTracker.state;
      var idleTarget = getIdleTarget(timeMs, chain.base);
      var pointerTarget = null;
      var markerTargetLocal;
      var solveTarget;

      function mapPointerForThree(rect) {
        if (useCadModel && interaction.pointerPlaneMode !== "workspace") {
          var worldPoint = mapPointerToWorldPlane(
            camera,
            rect,
            pointer,
            interaction,
            lookAt
          );
          return worldPointToLocal(worldPoint, cadTransform);
        }

        return mapPointerToWorkspace(
          rect,
          pointer,
          workspace,
          interaction.mousePlaneZ
        );
      }

      if (pointer.hasPointer) {
        var heroRect = hero.getBoundingClientRect();
        if (interaction.scope === "hero") {
          if (pointer.insideHero) {
            pointerTarget = mapPointerForThree(heroRect);
          }
        } else {
          pointerTarget = mapPointerForThree(getViewportRect());
        }
      }

      targetRaw = pointerTarget || idleTarget;
      markerTargetLocal = targetRaw;
      var renderTarget = markerTargetLocal;
      var activeVisual = visual && visual.active ? visual.active : null;
      if (activeVisual && activeVisual.mode === "cad" && cadTransform) {
        renderTarget = localPointToWorld(markerTargetLocal, cadTransform);
      }

      var fk = null;
      var useDirectUrdfIK =
        Boolean(activeVisual) &&
        activeVisual.mode === "cad" &&
        activeVisual.ikMode === "urdf";

      if (useDirectUrdfIK) {
        targetCurrent[0] = targetRaw[0];
        targetCurrent[1] = targetRaw[1];
        targetCurrent[2] = targetRaw[2];
        solveTarget = targetRaw.slice(0, 3);
      } else {
        smoothTarget(targetCurrent, targetRaw, smoothing);
        solveTarget = targetCurrent.slice(0, 3);
      }

      if (Boolean(ikConfig.clamp_workspace)) {
        solveTarget = window.SO101IK.clampTarget(
          solveTarget,
          workspace,
          chain.base
        );
      }
      targetClamped = solveTarget;

      if (useDirectUrdfIK) {
        solveCadURDFPositionIK(activeVisual, renderTarget, ikConfig);
      } else {
        var desiredAngles = window.SO101IK.solveSOPositionIK(
          chain,
          solveTarget,
          ikConfig
        );
        var i;
        for (i = 0; i < chain.angles.length; i += 1) {
          chain.angles[i] += (desiredAngles[i] - chain.angles[i]) * jointSmoothing;
          chain.angles[i] = clamp(
            chain.angles[i],
            chain.limits[i][0],
            chain.limits[i][1]
          );
        }

        var refineIterations = Number(ikConfig.refine_iterations) || 0;
        if (refineIterations > 0) {
          window.SO101IK.solveDLSIK(chain, solveTarget, {
            iterations: refineIterations,
            damping: Number(ikConfig.refine_damping) || 0.16,
            epsilon: Number(ikConfig.epsilon) || 0.005,
            max_step_deg: Number(ikConfig.refine_max_step_deg) || 4.0,
          });
        }

        fk = window.SO101IK.forwardKinematics(chain);
      }

      if (activeVisual && activeVisual.mode === "cad") {
        updateCadGripperFromProximity(
          activeVisual,
          renderTarget,
          gripperProximity,
          gripperState
        );
      }

      setThreeRobotFromFK(visual, fk, renderTarget, chain.angles);
      renderer.render(scene, camera);
      rafHandle = window.requestAnimationFrame(animate);
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (rafHandle) {
        window.cancelAnimationFrame(rafHandle);
      }
      window.removeEventListener("resize", onResize);
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
      if (visual && typeof visual.dispose === "function") {
        visual.dispose();
      }
      renderer.dispose();
    }

    function getStatus() {
      return {
        cadReady: Boolean(visual && visual.cadReady),
        cadFailed: Boolean(visual && visual.cadFailed),
        cadError: visual && visual.cadError ? visual.cadError : null,
      };
    }

    window.addEventListener("resize", onResize);
    setSize();
    animate(0);

    return {
      dispose: dispose,
      getStatus: getStatus,
    };
  }

  function bootRobotHero(retryCount) {
    bindHeroToggleListener();

    if (retryCount === 0) {
      if (HERO_BOOT_IN_PROGRESS || ACTIVE_HERO_SESSION) {
        return;
      }
      HERO_BOOT_IN_PROGRESS = true;
    }

    function finishBoot() {
      HERO_BOOT_IN_PROGRESS = false;
    }

    var hero = document.querySelector(HERO_SELECTOR);
    if (!hero) {
      finishBoot();
      return;
    }

    var config = parseConfig(hero);
    if (!config || !config.enabled) {
      finishBoot();
      return;
    }

    if (!areSiteAnimationsEnabled()) {
      setHeroStaticState(hero);
      finishBoot();
      return;
    }

    if (!window.SO101IK) {
      if (retryCount < MAX_BOOT_RETRIES) {
        window.setTimeout(function () {
          bootRobotHero(retryCount + 1);
        }, 120);
      } else {
        warnOnce(
          "ik-missing",
          "SO101 IK solver was not available. Falling back to static hero."
        );
        setHeroStaticState(hero);
        finishBoot();
      }
      return;
    }

    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    var forceInteractive = Boolean(config.force_interactive);
    var minWidth = Number(config.desktop_min_width) || 0;
    var modelConfig = config.model || {};
    var requiresCad = Boolean(modelConfig.use_cad);
    var allowSoftwareFallback = Boolean(config.debug_allow_software_fallback);
    var layer = hero.querySelector(".js-robot-hero-layer");
    if (!layer) {
      finishBoot();
      return;
    }

    function setStaticMode() {
      hero.classList.remove("home-hero--robot-loading");
      hero.classList.remove("home-hero--robot-active");
      hero.classList.add("home-hero--robot-static");
    }

    function setLoadingMode() {
      hero.classList.remove("home-hero--robot-static");
      hero.classList.remove("home-hero--robot-active");
      hero.classList.add("home-hero--robot-loading");
    }

    function setActiveMode() {
      hero.classList.remove("home-hero--robot-static");
      hero.classList.remove("home-hero--robot-loading");
      hero.classList.add("home-hero--robot-active");
    }

    var webglReady = Boolean(window.THREE) && supportsWebGL();
    var cadDependenciesReady = !requiresCad || hasCadDependencies();
    var shouldRetryDependencies =
      (!webglReady && !window.THREE) || (requiresCad && !cadDependenciesReady);

    if (shouldRetryDependencies && retryCount < MAX_BOOT_RETRIES) {
      window.setTimeout(function () {
        bootRobotHero(retryCount + 1);
      }, 120);
      return;
    }

    if (!forceInteractive && (reducedMotion.matches || window.innerWidth < minWidth)) {
      setStaticMode();
      finishBoot();
      return;
    }

    function mountRenderer(rendererHandle, pointerTracker) {
      var statusPollHandle = null;
      var disposed = false;
      var sessionHandle = null;

      function clearStatusPoll() {
        if (statusPollHandle) {
          window.clearInterval(statusPollHandle);
          statusPollHandle = null;
        }
      }

      function teardown() {
        if (disposed) {
          return;
        }
        disposed = true;
        clearStatusPoll();
        if (rendererHandle && typeof rendererHandle.dispose === "function") {
          rendererHandle.dispose();
        }
        if (pointerTracker && typeof pointerTracker.dispose === "function") {
          pointerTracker.dispose();
        }
        document.removeEventListener("visibilitychange", onVisibilityChange);
        if (ACTIVE_HERO_SESSION === sessionHandle) {
          ACTIVE_HERO_SESSION = null;
        }
      }

      function onVisibilityChange() {
        if (!document.hidden) {
          return;
        }
        teardown();
      }

      document.addEventListener("visibilitychange", onVisibilityChange);

      if (typeof rendererHandle.getStatus === "function") {
        statusPollHandle = window.setInterval(function () {
          if (disposed) {
            clearStatusPoll();
            return;
          }

          var status = rendererHandle.getStatus();
          if (!status) {
            return;
          }

          if (status.cadReady) {
            setActiveMode();
            clearStatusPoll();
            return;
          }

          if (status.cadFailed) {
            warnOnce(
              "cad-load-failed",
              "SO101 CAD mesh failed to load. Showing static fallback.",
              status.cadError
            );
            teardown();
            setStaticMode();
          }
        }, CAD_STATUS_POLL_INTERVAL_MS);
      }

      sessionHandle = {
        dispose: teardown,
      };
      ACTIVE_HERO_SESSION = sessionHandle;
      HERO_BOOT_IN_PROGRESS = false;
    }

    if (!webglReady) {
      warnOnce(
        "webgl-unavailable",
        "WebGL was unavailable for SO101 hero rendering."
      );
      if (!allowSoftwareFallback) {
        setStaticMode();
        finishBoot();
        return;
      }
      warnOnce(
        "software-fallback",
        "Using debug software fallback because WebGL is unavailable."
      );
      setActiveMode();
      var softwarePointerWebgl = createPointerTracker(hero);
      mountRenderer(
        createSoftwareRenderer(hero, layer, config, softwarePointerWebgl),
        softwarePointerWebgl
      );
      return;
    }

    if (!cadDependenciesReady) {
      warnOnce(
        "cad-deps-missing",
        "SO101 CAD dependencies were unavailable after retries."
      );
      if (!allowSoftwareFallback) {
        setStaticMode();
        finishBoot();
        return;
      }
      warnOnce(
        "software-fallback-cad",
        "Using debug software fallback because CAD dependencies are missing."
      );
      setActiveMode();
      var softwarePointerCad = createPointerTracker(hero);
      mountRenderer(
        createSoftwareRenderer(hero, layer, config, softwarePointerCad),
        softwarePointerCad
      );
      return;
    }

    setLoadingMode();
    var pointerTracker = createPointerTracker(hero);
    var threeRenderer = createThreeRenderer(hero, layer, config, pointerTracker);
    mountRenderer(threeRenderer, pointerTracker);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      bootRobotHero(0);
    });
  } else {
    bootRobotHero(0);
  }
})();
