---
summary: Diplomat Architecture — Nubank's hexagonal architecture for functional programming backend services.
keywords: diplomat, architecture, hexagonal, controller, logic, model, adapters, wire, components, config, kafka, http, datomic, pure-functions, side-effects
description: Condensed guidance for applying Diplomat Architecture in Functional Programming services.
globs:
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.ts"
  - "**/*.tsx"
alwaysApply: false
---

# Diplomat Architecture

This file condenses the Diplomat Architecture concepts page into an AI-loadable rule file shape aligned with the existing AI-rules conventions.

## Overview

Diplomat Architecture is a Nubank pattern based on Hexagonal Architecture. Its main goal is to isolate the service's domain layer from external concerns such as databases, HTTP, Kafka, files, and other services, reducing coupling and protecting business logic from infrastructure details.

The architecture is organized around two main zones:
* Domain Layer: controllers, logic, models.
* External Layer: diplomat, adapters, wire, components, config, databases, resources.

## Core terminology

### Side effects

A function has a side effect when it does something observable beyond returning a value, such as logging, mutating state, writing to a database, performing I/O, or calling another side-effecting function.

### Referential transparency

A function is referentially transparent when it always returns the same result for the same inputs and does not depend on hidden external state such as current time, databases, or HTTP responses.

### Pure functions

A function is pure when it is referentially transparent and has no side effects. In Diplomat Architecture, this is a requirement for logic and adapter functions.

### Exceptions

Exceptions are not treated as side effects, but they should be reserved for unexpected or unrecoverable situations rather than normal domain outcomes.

## Domain Layer

### Controller

Controllers orchestrate a domain flow. They typically call logic plus external collaborators to gather information or produce effects, so they are usually impure.

Rules:
* Controllers orchestrate flows; they do not own input adaptation or storage concerns.
* Controllers should work with models, not wire schemas directly.
* Controllers may call diplomats and may receive components needed for orchestration.
* Controllers should not call adapters directly; adaptation is the diplomat's responsibility.

A good controller shape is query external state first, run logic on models, then emit effects if needed.

### Logic

Logic implements business rules and conditionals from the domain. It must be pure and may only call other logic functions.

Rules:
* Logic must be deterministic and side-effect free.
* Logic can call only other logic.
* Logic must not access components, config, databases, HTTP clients, producers, current time, or other runtime state directly.
* Logic benefits from high unit-test coverage because it is pure.

### Model

Models represent domain entities and should be the only data structures used inside the Domain Layer.

Rules:
* Prefer strict schemas that reject undeclared attributes.
* Use the schema framework/lib for model definitions (zod in this project).
* Do not make models mirror database entities; database representations belong in wire database schemas and adapters.

## External Layer

### Diplomat

Diplomats are responsible for communication with resources outside the domain, including HTTP, Kafka, storage, files, and third parties. Data crossing those boundaries should use wire schemas.

#### Consumers

Consumers receive asynchronous input such as Kafka messages, deserialize them with declared schemas, adapt incoming wire data to models, and hand execution to controllers.

#### Producers

Producers send asynchronous output. They usually receive models, adapt them to wire schemas, and publish them to a topic with explicit settings.

#### HTTP server

HTTP server code handles inbound synchronous requests. It should parse and externalize data at the edge, adapt request wire to models, call controllers, then adapt results back to response wire.

#### HTTP client

HTTP client code handles outbound synchronous requests. It should encapsulate request details and return only the data the domain needs, usually after adapting or extracting it from the response.

#### Databases and resources

Database and resource namespaces communicate with external storage or files and should contain no business logic. They adapt between model schemas and external representations before or after I/O as needed.

### Adapters

Adapters translate between wire schemas and model schemas, and between database schemas and model schemas. They must be pure functions.

Naming conventions:
* `wire->model`
* `model->wire`
* `datomic->model`
* `model->datomic`

Adapters belong at the service boundary, not inside the domain flow itself.

### Wire

Wire schemas represent external data structures and should exist only at the service boundary, never inside the Domain Layer.

Rules:
* `wire.in` is for inbound external data and should usually be loose to support tolerant readers.
* `wire.out` is for outbound data exposed by this service and should be strict.
* `wire.databases` should strictly model database entities and be converted to and from models when crossing the boundary.

### Components / Main / Deps

Components manage lifecycle and dependencies for stateful runtime collaborators such as config, HTTP, Kafka, and databases. They are a dependency-injection style mechanism built around immutable data structures.

Rules:
* Components may be used by diplomats and controllers.
* Components should not be used inside logic functions.

### Config

Config is treated as part of the external layer. Read config through simple accessor functions, and adapt values before using them in domain logic if necessary.

## Dependency rules

A concise dependency model aligned with the existing rule-file version is:

| Namespace | Can depend on |
| --- | --- |
| controller | logic, models, diplomat.\*, config, components, |
| logic | logic, models only |
| model | schema definitions only |
| adapter | wire.\*, models |
| diplomat.\* | adapters, wire.\*, models, controllers, components |
| wire.\* | schema definitions only |

## Anti-patterns to avoid

* Logic with side effects.
* Controller calling adapters directly.
* Using wire schemas in the domain layer.
* Making model schemas identical to database schemas.
* Hiding external state access inside logic.

## Suggested directory structure

A practical file layout commonly used in the existing rule-file version is:

```text
src/
├── adapters/
├── main.ts
├── config.ts
├── controllers/
├── diplomat/
│   ├── consumer/
│   ├── producer/
│   ├── http/
│   ├── mcp/
│   └── db/
├── logic/
├── models/
└── wire/
    ├── in/
    ├── out/
    └── db/
```

## Working heuristics

* Keep business rules in `logic`, orchestration in `controllers`, and boundary translation in `adapters`.
* Convert external data to models as early as possible and convert models back to wire as late as possible.
* Prefer pure functions wherever possible, especially in logic and adapters, because they are easier to test and evolve safely.