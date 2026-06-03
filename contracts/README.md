# ImagiBricks Contracts

This directory contains the shared integration contracts for the ImagiBricks platform.

Use this package to:
- define API schemas for each independent service
- define event payload schemas for asynchronous integration
- share DTO definitions and generated client code between projects
- version contracts explicitly before changing service interfaces

## Structure
- `openapi/`: OpenAPI definitions for service APIs
- `events/`: event schema definitions for integration events
- `package.json`: npm package metadata for publishing and sharing contract artifacts
