(function (global) {
  "use strict";

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function toRad(degrees) {
    return (Number(degrees) || 0) * (Math.PI / 180);
  }

  function vec3(x, y, z) {
    return [x, y, z];
  }

  function add(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }

  function sub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  function scale(a, s) {
    return [a[0] * s, a[1] * s, a[2] * s];
  }

  function length(a) {
    return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function identity3() {
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  }

  function mulMat3(a, b) {
    var result = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    var row;
    var col;
    var k;
    for (row = 0; row < 3; row += 1) {
      for (col = 0; col < 3; col += 1) {
        for (k = 0; k < 3; k += 1) {
          result[row][col] += a[row][k] * b[k][col];
        }
      }
    }
    return result;
  }

  function mulMatVec3(mat, vec) {
    return [
      mat[0][0] * vec[0] + mat[0][1] * vec[1] + mat[0][2] * vec[2],
      mat[1][0] * vec[0] + mat[1][1] * vec[1] + mat[1][2] * vec[2],
      mat[2][0] * vec[0] + mat[2][1] * vec[1] + mat[2][2] * vec[2],
    ];
  }

  function rotationY(angle) {
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    return [
      [c, 0, s],
      [0, 1, 0],
      [-s, 0, c],
    ];
  }

  function rotationZ(angle) {
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    return [
      [c, -s, 0],
      [s, c, 0],
      [0, 0, 1],
    ];
  }

  function invert3x3(m) {
    var a = m[0][0];
    var b = m[0][1];
    var c = m[0][2];
    var d = m[1][0];
    var e = m[1][1];
    var f = m[1][2];
    var g = m[2][0];
    var h = m[2][1];
    var i = m[2][2];

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

  function matVec3(mat, vec) {
    return [
      mat[0][0] * vec[0] + mat[0][1] * vec[1] + mat[0][2] * vec[2],
      mat[1][0] * vec[0] + mat[1][1] * vec[1] + mat[1][2] * vec[2],
      mat[2][0] * vec[0] + mat[2][1] * vec[1] + mat[2][2] * vec[2],
    ];
  }

  function pointToSegmentDistance(point, segmentStart, segmentEnd) {
    var ab = sub(segmentEnd, segmentStart);
    var ap = sub(point, segmentStart);
    var abLenSq = dot(ab, ab);
    if (abLenSq < 1e-12) {
      return length(ap);
    }
    var t = clamp(dot(ap, ab) / abLenSq, 0, 1);
    var closest = add(segmentStart, scale(ab, t));
    return length(sub(point, closest));
  }

  function arrayOrDefault(value, fallback) {
    if (Array.isArray(value)) {
      return value;
    }
    return fallback;
  }

  function makeLimitPair(input, fallbackMin, fallbackMax) {
    var pair = arrayOrDefault(input, [fallbackMin, fallbackMax]);
    return [toRad(pair[0]), toRad(pair[1])];
  }

  function createChain(config) {
    var lengths = arrayOrDefault(config.arm_lengths, [0.72, 0.63, 0.5]).map(function (x) {
      return Number(x) || 0;
    });

    var initialAngles = arrayOrDefault(config.initial_angles_deg, [12, 38, -52, 18]).map(function (x) {
      return toRad(x);
    });

    while (initialAngles.length < 4) {
      initialAngles.push(0);
    }

    var limits = config.joint_limits_deg || {};
    var useCadBase =
      Boolean(config.model && config.model.use_cad) &&
      Array.isArray(config.model.root_position);
    var basePositionInput = arrayOrDefault(
      useCadBase ? config.model.root_position : config.base_position,
      [0, 0, 0]
    );
    while (basePositionInput.length < 3) {
      basePositionInput.push(0);
    }
    var basePosition = [
      Number(basePositionInput[0]) || 0,
      Number(basePositionInput[1]) || 0,
      Number(basePositionInput[2]) || 0,
    ];

    return {
      base: vec3(basePosition[0], basePosition[1], basePosition[2]),
      baseHeight: Number(config.base_height) || 0.24,
      lengths: lengths,
      angles: initialAngles.slice(0, 4),
      limits: [
        makeLimitPair(limits.yaw, -140, 140),
        makeLimitPair(limits.shoulder, -85, 95),
        makeLimitPair(limits.elbow, -140, 25),
        makeLimitPair(limits.wrist, -120, 120),
      ],
    };
  }

  function forwardKinematics(chain) {
    var base = chain.base;
    var R = identity3();

    var basePos = vec3(base[0], base[1], base[2]);
    var axisYaw = vec3(0, 1, 0);
    var posShoulder;
    var axisShoulder;
    var posElbow;
    var axisElbow;
    var posWrist;
    var axisWrist;
    var effector;

    R = mulMat3(R, rotationY(chain.angles[0]));
    posShoulder = add(basePos, mulMatVec3(R, vec3(0, chain.baseHeight, 0)));

    axisShoulder = mulMatVec3(R, vec3(0, 0, 1));
    R = mulMat3(R, rotationZ(chain.angles[1]));
    posElbow = add(posShoulder, mulMatVec3(R, vec3(0, chain.lengths[0], 0)));

    axisElbow = mulMatVec3(R, vec3(0, 0, 1));
    R = mulMat3(R, rotationZ(chain.angles[2]));
    posWrist = add(posElbow, mulMatVec3(R, vec3(0, chain.lengths[1], 0)));

    axisWrist = mulMatVec3(R, vec3(0, 0, 1));
    R = mulMat3(R, rotationZ(chain.angles[3]));
    effector = add(posWrist, mulMatVec3(R, vec3(0, chain.lengths[2], 0)));

    return {
      jointPositions: [basePos, posShoulder, posElbow, posWrist],
      jointAxes: [axisYaw, axisShoulder, axisElbow, axisWrist],
      endEffector: effector,
      segments: [
        [basePos, posShoulder],
        [posShoulder, posElbow],
        [posElbow, posWrist],
        [posWrist, effector],
      ],
    };
  }

  function solveDLSIK(chain, target, options) {
    var opts = options || {};
    var iterations = Math.max(1, Number(opts.iterations) || 10);
    var damping = Number(opts.damping) || 0.2;
    var epsilon = Number(opts.epsilon) || 0.01;
    var maxStep = toRad(Number(opts.max_step_deg) || 4);
    var iteration;
    var fk = forwardKinematics(chain);

    for (iteration = 0; iteration < iterations; iteration += 1) {
      fk = forwardKinematics(chain);
      var error = sub(target, fk.endEffector);
      if (length(error) < epsilon) {
        break;
      }

      var columns = [];
      var jointIndex;
      for (jointIndex = 0; jointIndex < 4; jointIndex += 1) {
        var axis = fk.jointAxes[jointIndex];
        var jointPos = fk.jointPositions[jointIndex];
        columns.push(cross(axis, sub(fk.endEffector, jointPos)));
      }

      var jjt = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];

      var row;
      var col;
      for (jointIndex = 0; jointIndex < columns.length; jointIndex += 1) {
        for (row = 0; row < 3; row += 1) {
          for (col = 0; col < 3; col += 1) {
            jjt[row][col] += columns[jointIndex][row] * columns[jointIndex][col];
          }
        }
      }

      jjt[0][0] += damping * damping;
      jjt[1][1] += damping * damping;
      jjt[2][2] += damping * damping;

      var inverse = invert3x3(jjt);
      if (!inverse) {
        break;
      }

      var projected = matVec3(inverse, error);

      for (jointIndex = 0; jointIndex < 4; jointIndex += 1) {
        var delta = dot(columns[jointIndex], projected);
        delta = clamp(delta, -maxStep, maxStep);
        chain.angles[jointIndex] += delta;
        chain.angles[jointIndex] = clamp(
          chain.angles[jointIndex],
          chain.limits[jointIndex][0],
          chain.limits[jointIndex][1]
        );
      }
    }

    return forwardKinematics(chain);
  }

  function solveSOPositionIK(chain, target, options) {
    var opts = options || {};
    var base = chain.base || [0, 0, 0];
    var baseHeight = Number(chain.baseHeight) || 0;
    var x = (Number(target[0]) || 0) - base[0];
    var y = (Number(target[1]) || 0) - base[1] - baseHeight;
    var z = (Number(target[2]) || 0) - base[2];

    var l1 = Number(chain.lengths[0]) || 0.7;
    var l2 = Number(chain.lengths[1]) || 0.6;
    var l3 = Number(chain.lengths[2]) || 0.5;

    // Yaw sign is inverted to match the current world transform convention.
    var yaw = Math.atan2(-z, x);
    var radial = Math.sqrt(x * x + z * z);

    var toolPitch = toRad(
      typeof opts.tool_pitch_deg === "number" ? opts.tool_pitch_deg : -8
    );

    // Our planar chain is defined from +Y with rotations around Z:
    // radial = -L*sin(theta), vertical = L*cos(theta)
    // so the wrist center is derived using that convention.
    var wristRadial = radial + l3 * Math.sin(toolPitch);
    var wristVertical = y - l3 * Math.cos(toolPitch);

    var wristDist = Math.sqrt(
      wristRadial * wristRadial + wristVertical * wristVertical
    );
    var minReach = Math.abs(l1 - l2) + 1e-6;
    var maxReach = Math.max(l1 + l2 - 1e-6, minReach);
    wristDist = clamp(wristDist, minReach, maxReach);

    var cosElbow = clamp(
      (wristDist * wristDist - l1 * l1 - l2 * l2) / (2 * l1 * l2),
      -1,
      1
    );
    var elbowSign = opts.elbow_up ? 1 : -1;
    var elbow = elbowSign * Math.acos(cosElbow);

    // Convert to standard 2-link form where angle zero is +X:
    // x_std = vertical, y_std = -radial
    var xStd = wristVertical;
    var yStd = -wristRadial;
    var shoulder =
      Math.atan2(yStd, xStd) -
      Math.atan2(l2 * Math.sin(elbow), l1 + l2 * Math.cos(elbow));

    var wrist = toolPitch - shoulder - elbow;

    var desired = [yaw, shoulder, elbow, wrist];
    var i;
    for (i = 0; i < desired.length; i += 1) {
      desired[i] = clamp(desired[i], chain.limits[i][0], chain.limits[i][1]);
    }

    var blend = Number(opts.analytic_seed_blend);
    if (!isFinite(blend)) {
      blend = 0.68;
    }
    blend = clamp(blend, 0, 1);

    var probe = {
      base: chain.base.slice(0, 3),
      baseHeight: chain.baseHeight,
      lengths: chain.lengths.slice(0, 3),
      limits: chain.limits.map(function (pair) {
        return [pair[0], pair[1]];
      }),
      angles: chain.angles.slice(0, 4),
    };

    for (i = 0; i < probe.angles.length; i += 1) {
      probe.angles[i] = clamp(
        lerp(probe.angles[i], desired[i], blend),
        probe.limits[i][0],
        probe.limits[i][1]
      );
    }

    solveDLSIK(probe, target, {
      iterations: Number(opts.iterations) || 48,
      damping: Number(opts.damping) || 0.14,
      epsilon: Number(opts.epsilon) || 0.005,
      max_step_deg: Number(opts.max_step_deg) || 7.5,
    });

    applySelfCollisionGuards(probe, opts);

    var postGuardRefine = Math.max(
      0,
      Math.floor(Number(opts.post_guard_refine_iterations) || 5)
    );
    if (postGuardRefine > 0) {
      solveDLSIK(probe, target, {
        iterations: postGuardRefine,
        damping: Number(opts.refine_damping) || 0.18,
        epsilon: Number(opts.epsilon) || 0.005,
        max_step_deg: Number(opts.refine_max_step_deg) || 3.0,
      });
      applySelfCollisionGuards(probe, opts);
    }

    return probe.angles.slice(0, 4);
  }

  function applySelfCollisionGuards(chain, opts) {
    if (opts && opts.self_collision_guard === false) {
      return;
    }

    var preferredElbowSign = Number(opts && opts.elbow_preferred_sign);
    preferredElbowSign = preferredElbowSign >= 0 ? 1 : -1;

    var elbowMinAbs = toRad(
      typeof opts.elbow_min_abs_deg === "number" ? opts.elbow_min_abs_deg : 18
    );
    var elbow = chain.angles[2];
    if (elbow * preferredElbowSign < elbowMinAbs) {
      chain.angles[2] = preferredElbowSign * elbowMinAbs;
    }

    var k;
    for (k = 0; k < chain.angles.length; k += 1) {
      chain.angles[k] = clamp(
        chain.angles[k],
        chain.limits[k][0],
        chain.limits[k][1]
      );
    }

    var fk = forwardKinematics(chain);
    var base = fk.jointPositions[0];
    var shoulder = fk.jointPositions[1];
    var elbowPos = fk.jointPositions[2];
    var wrist = fk.jointPositions[3];
    var endEff = fk.endEffector;

    var clearanceRadius = Number(opts && opts.base_clearance_radius);
    if (!isFinite(clearanceRadius) || clearanceRadius <= 0) {
      clearanceRadius = Math.max(
        0.34,
        Math.min(
          (Number(chain.lengths[0]) || 1) * 0.24,
          (Number(chain.lengths[1]) || 1) * 0.27
        )
      );
    }

    var minDist = Math.min(
      pointToSegmentDistance(base, shoulder, elbowPos),
      pointToSegmentDistance(base, elbowPos, wrist),
      pointToSegmentDistance(base, wrist, endEff)
    );

    if (minDist < clearanceRadius) {
      var push = clamp((clearanceRadius - minDist) / clearanceRadius, 0, 1);
      chain.angles[1] += toRad(14) * push;
      chain.angles[2] += preferredElbowSign * toRad(20) * push;
      chain.angles[3] -= preferredElbowSign * toRad(8) * push;

      for (k = 0; k < chain.angles.length; k += 1) {
        chain.angles[k] = clamp(
          chain.angles[k],
          chain.limits[k][0],
          chain.limits[k][1]
        );
      }
    }
  }

  function clampTarget(target, workspace, base) {
    var x = Number(target[0]) || 0;
    var y = Number(target[1]) || 0;
    var z = Number(target[2]) || 0;
    var basePos = base || [0, 0, 0];

    if (workspace) {
      if (typeof workspace.min_x === "number") {
        x = Math.max(workspace.min_x, x);
      }
      if (typeof workspace.max_x === "number") {
        x = Math.min(workspace.max_x, x);
      }
      if (typeof workspace.min_y === "number") {
        y = Math.max(workspace.min_y, y);
      }
      if (typeof workspace.max_y === "number") {
        y = Math.min(workspace.max_y, y);
      }
      if (typeof workspace.min_z === "number") {
        z = Math.max(workspace.min_z, z);
      }
      if (typeof workspace.max_z === "number") {
        z = Math.min(workspace.max_z, z);
      }

      if (typeof workspace.radius === "number") {
        var delta = sub([x, y, z], basePos);
        var dist = length(delta);
        if (dist > workspace.radius && dist > 0) {
          var scaled = scale(delta, workspace.radius / dist);
          x = basePos[0] + scaled[0];
          y = basePos[1] + scaled[1];
          z = basePos[2] + scaled[2];
        }
      }

      if (typeof workspace.min_radius === "number") {
        var minDelta = sub([x, y, z], basePos);
        var minDist = length(minDelta);
        if (minDist < workspace.min_radius && minDist > 0) {
          var minScaled = scale(minDelta, workspace.min_radius / minDist);
          x = basePos[0] + minScaled[0];
          y = basePos[1] + minScaled[1];
          z = basePos[2] + minScaled[2];
        }
      }
    }

    return [x, y, z];
  }

  global.SO101IK = {
    toRad: toRad,
    createChain: createChain,
    forwardKinematics: forwardKinematics,
    solveDLSIK: solveDLSIK,
    solveSOPositionIK: solveSOPositionIK,
    clampTarget: clampTarget,
  };
})(window);
