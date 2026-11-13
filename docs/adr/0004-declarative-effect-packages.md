# Use validated assets and declared behaviors for effects

AI-assisted creators will produce effect packages containing supported assets and declared behaviors, such as face attachment points, expression reactions, and secondary motion, rather than arbitrary executable code. The creator workflow validates packages before import, giving different AI harnesses a consistent authoring target and making complexity limits enforceable. New behavior capabilities require explicit runtime support rather than permitting each effect to supply its own unrestricted implementation.

One complete effect is active at a time; a complete effect may combine a mask, moving parts, and a color treatment. The initial occlusion capability hides virtual geometry behind the face; realistic hand-over-mask occlusion is deferred. The package schema and validation mechanism remain undecided.

Update: schema v1 (mask and/or color treatment) and schema v2 (adds a bounded declarative face distortion) are implemented and documented in `docs/effect-packages.md`. The distortion is a fixed runtime radial warp with bounded parameters, not package-supplied geometry or code, so this decision is unchanged.
