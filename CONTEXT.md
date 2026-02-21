# Project Context: TravelBDS Shopify Theme

This project is a custom **Shopify Theme**.

## Structure
The source code provided in `travelbds_full_code.zip` follows the standard Shopify theme structure:
- `/assets`: Images, CSS, and localized JS.
- `/config`: Theme settings schema.
- `/layout`: Main theme shell (`theme.liquid`).
- `/sections`: Reusable theme sections.
- `/snippets`: Reusable Liquid snippets.
- `/templates`: Page-specific templates (e.g., `index.liquid`, `product.liquid`).

## Core Technologies
- **Liquid**: Shopify's templating language.
- **Tailwind CSS**: Used for styling (v3 patterns).
- **Vanilla JavaScript**: Used for client-side interactivity (filtering, search).
- **Material Symbols**: Used for icons.

## Important Note for AI Agents
When tasked with modifying this site, you should:
1. **Read the ZIP file**: Unzip `travelbds_full_code.zip` to understand the base implementation.
2. **Shopify Context**: Remember that this is a theme, not a standalone web app. Changes must be made within the Liquid/JS/CSS files of the theme.
3. **Filtering Logic**: The homepage (`templates/index.liquid`) contains custom JS for product filtering based on JSON data rendered into the script.

## Recent Fixes Applied
- Fixed menu overlap on desktop by adding padding to the Hero section.
- Fixed FOUC (Flash of Unstyled Content) for icons by optimizing Google Fonts loading.
- Implemented robust search/filtering including duration and region mappings (e.g., "América").
- Added 300ms debounce to search input to prevent UI lag.
- Added horizontal padding to prevent content touching screen edges on mobile.
