# Retailer Taxonomy & Price Arbitrage (Vibe Coding Manual v5.0.4, Chapter 24)

## 1. Store Taxonomy
- **Direct Platform Stores**: Steam, GOG, Epic, PSN, Xbox.
- **Authorized Key Retailers**: Humble Store, Fanatical, Green Man Gaming, Gamesplanet, GameBillet.
- **Store Type Persistence**: `bestStoreType` must be persisted with every price record and surfaced anywhere a recommendation is shown. Values: `Direct Platform` | `Authorized Retailer`.
- **Classification Rule**: A store is an Authorized Retailer only if it appears in the authorized key retailer list; otherwise it is a Direct Platform.

## 2. Price Arbitrage & Historical Low Engine
- Ingest current multi-store pricing and retain historical low records.
- `AppPriceAlerts.isTriggered` must equal `1` when `currentPrice <= targetPrice`.
- Historical low records must distinguish verified all-time lows from incomplete or stale price histories.

## 3. Pure SVG Sparklines
- Price and metric trends use lightweight inline pure SVG polyline sparklines.
- Avoid heavy client charting libraries unless a WUD explicitly requires interactive chart behavior that a simple trend line cannot represent.
