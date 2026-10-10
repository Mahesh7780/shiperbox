# Shiperbox - End-to-End Project Documentation

## 1. Project Overview
**Shiperbox** is a comprehensive, multi-tenant e-commerce and logistics web application. It is engineered using the MERN stack (specifically React for the frontend and Node.js/Express for the backend) backed by a relational database (MySQL hosted on TiDB Cloud). The platform unifies daily grocery shopping, specialized floral/garland customizations, and localized courier services into a single monolithic architecture.

## 2. Need of the Project (Problem Statement & Solution)
### Problem Statement
Users typically have to rely on fragmented applications to fulfill their daily logistics and shopping needs. Buying daily vegetables, ordering customized floral arrangements (garlands) for events, and booking local courier services usually requires three different platforms, leading to poor user experience, multiple authentication silos, and disjointed address management.

### The Solution (Shiperbox)
Shiperbox provides a centralized platform that resolves this fragmentation by offering:
- **Unified E-commerce Module:** For seamless purchasing of `vegetables` and `flowers`.
- **Specialized Booking System:** A dedicated workflow for customized `garland` orders.
- **Integrated Courier/Logistics:** An on-demand courier booking system mapping predefined delivery routes (`courier_route`).
- **Unified Profile Management:** A single authentication token (JWT) and a centralized `addresses` book used across all three services.

## 3. Technology Stack
The project leverages modern web development paradigms and frameworks:

### Frontend (Client-Side)
* **Framework:** React.js (Bootstrapped via Create React App)
* **Routing:** `react-router-dom` (Client-side routing)
* **State Management & Data Fetching:** React Hooks, `axios` for asynchronous HTTP requests.
* **Integrations:** `@geoapify/react-geocoder-autocomplete` for intelligent location and address auto-completion.
* **Testing:** `@testing-library/react` and `jest`.

### Backend (Server-Side)
* **Runtime & Framework:** Node.js with `express` framework.
* **Database & ORM/Querying:** `mysql2/promise` connected to TiDB Cloud with SSL enforcement and connection pooling.
* **Authentication & Authorization:** `jsonwebtoken` (JWT) for stateless authentication, `bcryptjs` for password hashing.
* **File Storage:** `cloudinary`, `multer`, and `multer-storage-cloudinary` for cloud-based image asset management (products, ads, etc.).
* **Security & Middleware:** `helmet` for HTTP header security, `express-rate-limit` for mitigating DDoS/Brute-force attacks, and `cors` for Cross-Origin Resource Sharing policies.
* **Notifications:** `nodemailer` for SMTP emails and `whatsapp-web.js` for WhatsApp API integrations.
* **Search:** `fuse.js` for client/server-side fuzzy searching algorithms.

## 4. Database Schema & Core Entities
The relational database strictly normalizes data across several distinct modules. 

* **Authentication & Profiles:** 
  * `users`: Stores user credentials (`email`, hashed `password`), profile data, and timestamps.
  * `admins`: Stores administrative credentials and RBAC (Role-Based Access Control) properties.
  * `addresses`: Centralized geospatial data linked to `users` via foreign keys (`user_id`).
* **Catalog Management:**
  * `vegetables` & `flowers`: Product catalogs containing `name`, `price`, `stock`, `image`, and `quantity` metadata.
  * `ads`: Promotional banners and marketing assets.
* **Transaction & Order Management:**
  * `cart`: Ephemeral session storage for items added by the user prior to checkout.
  * `cart_orders`: Persisted transactional records for standard e-commerce purchases.
  * `garland_orders`: Specialized schema for custom floral requirements (event specifics, custom measurements).
  * `orders`: Designed for bulk/wholesale vegetable procurement.
* **Logistics & Courier:**
  * `courier_orders`: Booking records for the courier service, capturing pickup/drop logic.
  * `courier_route`: Predefined operational routes/stops for the courier network.

## 5. System Architecture & Modules

### A. Authentication Module (`/routes/auth.js`)
Implements JWT-based stateless authentication. It features OTP-based validation logic, secure password hashing using bcrypt, and rate-limiting to prevent brute-force attacks on login endpoints.

### B. E-Commerce Engine (`/routes/cart.js`, `/routes/items.js`, `/routes/orders.js`)
Operates as a standard CRUD-based shopping cart.
* **Concurrency Control:** Utilizes `FOR UPDATE` row-level locks during checkout to prevent race conditions during inventory (`stock`) deduction.
* **Checkout Pipeline:** Validates cart payload, parses JSON metadata, computes final totals, deducts inventory transactionally, and persists to `cart_orders`.

### C. Logistics Engine (`/routes/courier.js`)
Allows users to specify `route_from`, `route_to`, and package metadata. Calculates dynamic pricing based on distance/route IDs and provisions an asynchronous admin approval flow.

### D. Admin Control Panel (`/routes/adminRoutes.js`, `/routes/adminAuth.js`, `/routes/adminCourier.js`)
Protected routes requiring high-privilege Admin JWTs. Provides interfaces to:
* Perform CRUD operations on catalogs (`vegetables`, `flowers`, `ads`).
* Update order statuses (e.g., pending -> dispatched -> delivered).
* Manage courier routes and operational stops.

## 6. Security & Performance Optimizations
* **Connection Pooling:** The MySQL implementation uses connection pools (`connectionLimit: 10`) with `enableKeepAlive` to prevent `ECONNRESET` issues in stateless serverless environments.
* **Reverse Proxy Awareness:** Uses `app.set("trust proxy", 1)` to resolve true client IPs behind the Render load balancer for accurate rate limiting.
* **CORS Whitelisting:** Strictly validates the `Origin` header against `process.env.FRONTEND_URL` in production, blocking unauthorized DOMs from fetching API data.
* **Payload Size Limiting:** Caps `express.json` bodies to `2mb` to mitigate payload-flood vulnerabilities.
* **Asset Offloading:** Offloads base64/binary image uploads directly to Cloudinary, ensuring the Node process isn't bottlenecked by disk I/O or persistent volume constraints.
