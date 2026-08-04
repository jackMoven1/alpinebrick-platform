# MCP Integration System

**Status**: 🔳 Placeholder – Design Phase  
**Owner**: To be assigned (Integration Engineer)  
**Exposes**: MCP (Model Context Protocol) bridge to back-office agents  

---

## Overview

The **MCP Integration** system exposes AlpineBrick platform data to back-office AI agents:
- Orders, customers, products, inventory via MCP tools
- Back-office agents can query platform data
- Affiliate data exposure (commissions, payouts)
- Real-time inventory & order status for agents

---

## 🎯 Planned Features

- MCP server for platform data access
- Order query tools (by ID, customer, date range)
- Inventory query tools
- Customer query tools
- Affiliate query & payout tools
- Product catalog tools
- Analytics & reporting tools

---

## 📁 Documentation

### `/docs/`
- **SPEC.md** (TBD) – Technical specification
- **MCP-SCHEMA.md** (TBD) – Tool definitions & schemas
- **INTEGRATION-GUIDE.md** (TBD) – How back-office agents use MCP

---

## 🚀 Status

| Phase | Status |
|-------|--------|
| Design | 🔳 Pending |
| Hiring | 🔳 Pending |
| Development | 🔳 Not Started |

---

## 📚 Reference

- [MCP Specification](https://modelcontextprotocol.io)
- [Back-office Agent Architecture](../../CLAUDE.md)
- [Platform API Contracts](../../shared-docs/CONTRACTS.md)

---

## ⏭️ Next Steps

1. Engineering Lead designs MCP schema
2. Define tools & queries for back-office agents
3. Hire Integration Engineer
4. Build MCP server
5. Integrate with order, inventory, affiliate services
6. Test with back-office agent workflows

---

**Last Updated**: June 3, 2026  
**Maintained By**: Engineering Lead
