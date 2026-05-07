
npm warn config production Use `--omit=dev` instead.
> shopsell@1.0.0 start
> node server.js
Database initialized: /data/shopsell.db
╔══════════════════════════════════════════╗
║   ShopSell Server running on port 3000   ║
║   ENV: production                        ║
║   Stripe: Connected ✓║
╚══════════════════════════════════════════╝
  
UPS: Access token obtained successfully
Create label error: ReferenceError: billing is not defined
    at /app/server.js:967:25
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (/app/node_modules/express/lib/router/route.js:149:13)
    at Route.dispatch (/app/node_modules/express/lib/router/route.js:119:3)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at /app/node_modules/express/lib/router/index.js:284:15
    at Function.process_params (/app/node_modules/express/lib/router/index.js:346:12)
    at next (/app/node_modules/express/lib/router/index.js:280:10)
    at serveStatic (/app/node_modules/serve-static/index.js:75:16)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
Create label error: ReferenceError: billing is not defined
    at /app/server.js:967:25
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (/app/node_modules/express/lib/router/route.js:149:13)
    at Route.dispatch (/app/node_modules/express/lib/router/route.js:119:3)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at /app/node_modules/express/lib/router/index.js:284:15
    at Function.process_params (/app/node_modules/express/lib/router/index.js:346:12)
    at next (/app/node_modules/express/lib/router/index.js:280:10)
    at serveStatic (/app/node_modules/serve-static/index.js:75:16)
Stopping Container
npm error path /app
npm error command failed
npm error signal SIGTERM
npm error command sh -c node server.js
npm error A complete log of this run can be found in: /root/.npm/_logs/2026-05-07T05_07_17_818Z-debug-0.log
You reached the end of the range
May 6, 2026, 10:21 PM


