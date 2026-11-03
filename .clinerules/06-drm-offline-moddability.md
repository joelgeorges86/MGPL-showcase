# Storefront DRM, Offline & Moddability Intelligence (Vibe Coding Manual v5.0.4, Chapter 25)

## 1. DRM & Offline Contracts
- **Supported DRM Classifications**: `DRM-Free`, `Steamworks`, `Epic Online Services`, `Account/Denuvo`, `Console DRM`, `UWP`.
- **Offline Readiness**: Must be explicit — `Native Offline`, `Offline Token Required`, or `Strict Online Only`.
- Storefront intelligence must expose practical playability constraints rather than treating every ownership source as equivalent.

## 2. Modding Access & Community Mapping
- **Modding Access**: Classified as `Full File Access`, `Sandboxed/Hook`, or `Locked/Anti-Cheat`.
- **Community Taxonomy Mapping**: Resolve known modding hubs through deterministic domain functions such as `gameDomainForTitle()` before falling back to manual confirmation.
