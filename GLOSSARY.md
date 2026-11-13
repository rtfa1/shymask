# Shymask

Shymask applies visual effects to a physical webcam's video and makes the result available to other applications as a virtual webcam.

## Language

**Physical webcam**:
The camera that supplies the original video.

**Virtual webcam**:
A software-provided camera that other applications can select to receive Shymask's processed video.

**Effect**:
A selectable visual treatment applied to the webcam video, such as a face-attached mask, face distortion, or color treatment.

**Mask**:
An effect that attaches a visual covering or object to a person's tracked face.

**Creator**:
A person who creates or changes effects using an AI assistant and effect-authoring tools.

**Effect package**:
The importable collection of assets and declared behaviors that defines one complete effect.

**Face anchoring**:
The attachment of an effect's elements to the tracked position and orientation of a person's face.

**Face tracking**:
The estimation of the position and orientation of a person's face in the video input.

**Tracking readiness**:
The state before the face tracker has reported one reliable face. The paused output is shown until tracking is ready.

**Tracking loss**:
The state where no reliable single face is available: no face, an unreliable face pose, or more than one face. The paused output is shown until exactly one face returns and tracking is healthy.

**Rigid mask**:
A mask whose elements move together as one rigid body attached to the tracked face, without deformation or secondary motion.

**Occlusion**:
The hiding of an effect's elements where another surface, such as the person's face, should appear in front of them.

**Secondary motion**:
Movement of an effect's elements in response to the person's movement, such as fake hair swaying after a head turn.

**Movable part**:
A named node in a mask's GLB that the runtime rotates about one declared local axis with a bounded spring driven by tracked head motion.

**Paused output**:
An opaque replacement for the entire webcam image while tracking or effect processing is unavailable.
