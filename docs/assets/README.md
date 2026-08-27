# Brand assets

These assets were generated specifically for BoundedRelay with OpenAI's built-in
image generation on 2026-08-27. The repository cover and mark were optimized to
WebP; the LinkedIn post artwork remains a high-resolution PNG. No third-party
logos were intentionally included.

| Asset                                                                              | Intended use                       | Shape               |
| ---------------------------------------------------------------------------------- | ---------------------------------- | ------------------- |
| [`boundedrelay-cover.webp`](boundedrelay-cover.webp)                               | README hero and social preview     | `1672×941`          |
| [`boundedrelay-mark.webp`](boundedrelay-mark.webp)                                 | Repository avatar and compact mark | square, transparent |
| [`boundedrelay-linkedin-claude-codex.png`](boundedrelay-linkedin-claude-codex.png) | LinkedIn development-preview post  | `1672×941`          |

The cover is the primary visual. The transparent mark should be placed on a
solid dark or light background with enough clear space around the central gate.
Do not stretch either asset or overlay provider logos.

## Generation prompts

The built-in generator was used in stylized-concept mode for the cover:

```text
Create a premium wide GitHub README hero and social-preview cover for BoundedRelay.
Show two distinct abstract neural-code cores, violet on the left and cyan on the right,
connected through a central security validation gate with event pulses crossing it.
Use a midnight-navy technical grid, polished cinematic lighting, and exact title text
“BOUNDEDRELAY”. Include no other text, vendor logos, robots, brains, or watermark.
```

The built-in generator was used in logo-brand mode for the mark:

```text
Create a square, transparent, vector-friendly mark for BoundedRelay: two geometric AI
nodes passing one luminous pulse through a central validation gate. Use cyan, violet,
and deep navy. Include no text, provider logo, robot, brain, or watermark.
```

The built-in generator was used in precise-object-edit mode for the LinkedIn
Claude-and-Codex collaboration artwork, with the cover as the edit target:

```text
Preserve the premium BoundedRelay cover, but make the two abstract AI systems clearly
look like Claude and Codex actively communicating through the central BoundedRelay
policy gate. Keep the violet AI core on the left and label it exactly “CLAUDE”; keep
the cyan AI core on the right and label it exactly “CODEX”. Show alternating luminous
message pulses, abstract chat shapes, and structured code fragments traveling through
the gate. Preserve the exact “BOUNDEDRELAY” title, midnight-navy technical grid,
cinematic 3D style, and wide social-cover composition. Include no official provider
logos, provider icon imitations, extra text, robots, human faces, brains, fighting
imagery, or watermark.
```

Keep this record with the assets so future maintainers can reproduce or extend
the visual direction without guessing at its origin.
