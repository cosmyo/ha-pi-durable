# Third-party notices and provenance

Hearth Pi application code and original graphics are MIT licensed; see [LICENSE](../LICENSE). No community agent implementation or assets were copied. External sources in [research](research.md) are cited as ideas/contract evidence, not incorporated code or vulnerability determinations.

Runtime dependencies are exactly `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord` at 1.0.0 in `hearth_pi/package.json`; npm lockfiles pin transitives. Upstream packages describe MIT licensing; their own package notices and transitive licenses remain theirs. TypeScript, tsx, linkedom, yaml and Prettier are development dependencies. The App image references the pinned official Node 24.21.0 bookworm-slim index; Node/image and installed dependency licenses are not relicensed by our MIT file. Review actual lockfile, installed package licenses and container contents before distribution; no full third-party license audit or published artifact was performed.

Home Assistant and Pi names refer to separate projects, not endorsements. Public issue links are evidence of reports/requests, not a permission to reuse their code or private configurations.
