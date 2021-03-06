import indexedDBManager from './indexeddb-manager.js';
import utils from './utils.js';
import logger from './logger.js';

const DEFAULT_CACHE_NAME = 'defaultDSWCached';
const CACHE_CREATED_DBNAME = 'cacheCreatedTime';
let DEFAULT_CACHE_VERSION = null;

let DSWManager,
    PWASettings,
    goFetch;

// finds the real size of an utf-8 string
function lengthInUtf8Bytes(str) {
    // Matches only the 10.. bytes that are non-initial characters in a multi-byte sequence.
    var m = encodeURIComponent(str).match(/%[89ABab]/g);
    return str.length + (m ? m.length : 0);
}

const parseExpiration= (rule, expires)=>{
    let duration = expires || -1;
    
    if (typeof duration == 'string') {
        // let's use a formated string to know the expiration time
        const sizes = {
            s: 1,
            m: 60,
            h: 3600,
            d: 86400,
            w: 604800,
            M: 2592000,
            Y: 31449600
        };
        
        let size = duration.slice(-1),
            val = duration.slice(0, -1);
        if (sizes[size]) {
            duration = val * sizes[size];
        } else {
            logger.warn('Invalid duration ' + duration, rule);
            duration = -1;
        }
    }
    if (duration >= 0) {
        return parseInt(duration, 10) * 1000;
    } else {
        return 0;
    }
};

const cacheManager = {
    setup: (DSWMan, PWASet, ftch)=>{
        PWASettings = PWASet;
        DSWManager = DSWMan;
        goFetch = ftch;
        DEFAULT_CACHE_VERSION = PWASettings.dswVersion || '1';
        indexedDBManager.setup(cacheManager);
        // we will also create an IndexedDB to store the cache creationDates
        // for rules that have cash expiration
        indexedDBManager.create({
            version: 1,
            name: CACHE_CREATED_DBNAME,
            key: 'url'
        });
    },
    registeredCaches: [],
    createDB: db=>{
        return indexedDBManager.create(db);
    },
    // Delete all the unused caches for the new version of the Service Worker
    deleteUnusedCaches: keepUnused=>{
        if (!keepUnused) {
            return caches.keys().then(keys=>{
                cacheManager.registeredCaches;
                return Promise.all(keys.map(function(key) {
                    if (cacheManager.registeredCaches.indexOf(key) < 0) {
                        return caches.delete(key);
                    }
                }));
            });
        }
    },
    // return a name for a default rule or the name for cache using the version
    // and a separator
    mountCacheId: rule => {
        if(typeof rule == 'string') {
            return rule;
        }
        let cacheConf = rule? rule.action.cache : false;
        if (cacheConf) {
            return (cacheConf.name || DEFAULT_CACHE_NAME) +
                    '::' +
                    (cacheConf.version || DEFAULT_CACHE_VERSION);
        }
        return DEFAULT_CACHE_NAME + '::' + DEFAULT_CACHE_VERSION;
    },
    register: rule=>{
        cacheManager.registeredCaches.push(cacheManager.mountCacheId(rule));
    },
    // just a different method signature, for .add
    put: (rule, request, response) => {
        return cacheManager.add(
            request,
            typeof rule == 'string'? rule: cacheManager.mountCacheId(rule),
            response,
            rule
        );
    },
    add: (request, cacheId, response, rule) => {
        cacheId = cacheId || cacheManager.mountCacheId(rule);
        return new Promise((resolve, reject)=>{
            function addIt (response) {
                if (response.status == 200 || response.type == 'opaque') {
                    caches.open(cacheId).then(cache => {
                        // adding to cache
                        let opts = response.type == 'opaque'? { mode: 'no-cors' } : {};
                        request = utils.createRequest(request, opts);
                        if (request.method != 'POST') {
                            let cacheData = {};
                            if (rule && rule.action && rule.action.cache) {
                                cacheData = rule.action.cache;
                            } else {
                                cacheData = {
                                    name: cacheId,
                                    version: cacheId.split('::')[1]
                                };
                            }
                            DSWManager.traceStep(
                                request,
                                'Added to cache',
                                { cacheData }
                            );
                            cache.put(request, response.clone());
                        }
                        resolve(response);
                        // in case it is supposed to expire
                        if (rule &&
                            rule.action &&
                            rule.action.cache && rule.action.cache.expires) {
                            // saves the current time for further validation
                            cacheManager.setExpiringTime(request,
                                                         rule||cacheId,
                                                         rule.action.cache.expires);
                        }
                    }).catch(err=>{
                        logger.error(err);
                        resolve(response);
                    });
                } else {
                    reject(response);
                }
            }
            
            if (!response) {
                fetch(goFetch(null, request))
                    .then(addIt)
                    .catch(err=>{
                        DSWManager.traceStep(event.request, 'Fetch failed');
                        logger.error('[ DSW ] :: Failed fetching ' + (request.url || request), err);
                        reject(response);
                    });
            } else {
                addIt(response);
            }
        });
    },
    setExpiringTime: (request, rule, expiresAt=0)=>{
        if (typeof expiresAt == 'string') {
            expiresAt = parseExpiration(rule, expiresAt);
        }
        indexedDBManager.addOrUpdate(
            {
                url: request.url||request,
                dateAdded: (new Date).getTime(),
                expiresAt
            },
            CACHE_CREATED_DBNAME
        );
    },
    hasExpired: (request)=>{
        return new Promise((resolve, reject)=>{
            indexedDBManager.find(CACHE_CREATED_DBNAME, 'url', request.url || request)
                .then(r=>{
                    if (r && ((new Date).getTime() > r.dateAdded + r.expiresAt)) {
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                })
                .catch(_=>{
                    resolve(false);
                });
        });
    },
    get: (rule, request, event, matching, forceFromCache)=>{
        let actionType = Object.keys(rule.action)[0],
            url = request.url || request,
            pathName = (new URL(url)).pathname;

        // requests to / should be cached by default
        if (rule.action.cache !== false &&
            (pathName == '/' ||
            pathName.match(/^\/index\.([a-z0-9]+)/i))) {
            rule.action.cache = rule.action.cache || {};
        }

        let opts = rule.options || {};
        opts.headers = opts.headers || new Headers();
        
        actionType = actionType.toLowerCase();
        // let's allow an idb alias for indexeddb...maybe we could move it to a
        // separated structure
        actionType = actionType == 'idb'? 'indexeddb': actionType;
        
        // cache may expire...if so, we will use this verification afterwards
        let verifyCache;
        if (rule.action.cache && rule.action.cache.expires) {
            verifyCache = cacheManager.hasExpired(request);
        } else {
            // if it will not expire, we just use it as a resolved promise
            verifyCache = Promise.resolve();
        }
        
        switch (actionType) {
        case 'bypass': {
            // if it is a bypass action (no rule shall be applied, at all)
            if (rule.action[actionType] == 'request') {
                // it may be of type request
                // and we will simple allow it to go ahead
                // this also means we will NOT treat any result from it
                //logger.info('Bypassing request, going for the network for', request.url);
                
                let treatResponse = function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        DSWManager.traceStep(request, 'Request bypassed');
                        return response;
                    } else {
                        DSWManager.traceStep(request, 'Bypassed request failed and was ignored');
                        let resp = new Response(''); // ignored
                        return resp;
                    }
                };
                // here we will use a "raw" fetch, instead of goFetch, which would
                // create a new Request and define propreties to it
                return fetch(goFetch(null, event.request))
                        .then(treatResponse)
                        .catch(treatResponse);
            } else {
                // or of type 'ignore' (or anything else, actually)
                // and we will simply output nothing, as if ignoring both the
                // request and response
                DSWManager.traceStep(request, 'Bypassed request');
                actionType = 'output';
                rule.action[actionType] = '';
            }
        }
        case 'output': {
            DSWManager.traceStep(request, 'Responding with string output', { output: (rule.action[actionType]+'').substring(0, 180) });
            return new Response(
                utils.applyMatch(matching,
                                 rule.action[actionType])
            );
        }
        case 'indexeddb': {
            return new Promise((resolve, reject)=>{
                // function to be used after fetching
                function treatFetch (response) {
                    if (response && response.status == 200) {
                        // with success or not(saving it), we resolve it
                        let done = err=>{
                            if (err) {
                                DSWManager.traceStep(request, 'Could not save response into IndexedDB', { err });
                            } else {
                                DSWManager.traceStep(request, 'Response object saved into IndexedDB');
                            }
                            resolve(response);
                        };
                        // store it in the indexedDB
                        indexedDBManager.save(rule.name, response.clone(), request, rule)
                            .then(done)
                            .catch(done); // if failed saving, we still have the reponse to deliver
                    }else{
                        // if it failed, we can look for a fallback
                        url = request.url;
                        pathName = new URL(url).pathname;
                        DSWManager.traceStep(request, 'Fetch failed', {
                            url: request.url,
                            status: response.status,
                            statusText: response.statusText
                        });
                        return DSWManager.treatBadPage(response, pathName, event);
                    }
                }

                // let's look for it in our cache, and then in the database
                // (we use the cache, just so we can user)
                indexedDBManager.get(rule.name, request)
                    .then(result=>{
                        // if we did have it in the indexedDB
                        if (result) {
                            // we use it
                            return treatFetch(result);
                        }else{
                            // if it was not stored, let's fetch it
                            //request = DSWManager.createRequest(request, event, matching);
                            return goFetch(rule, request, event, matching)
                                .then(treatFetch)
                                .catch(treatFetch);
                        }
                    });
            });
        }
        case 'redirect':
        case 'fetch': {
            request = DSWManager.createRedirect(rule.action.fetch || rule.action.redirect,
                                                event,
                                                matching);
            url = request.url;
            pathName = new URL(url).pathname;
            // keep going to be treated with the cache case
        }
        case 'cache': {

            let cacheId;

            if(rule.action.cache){
                cacheId = cacheManager.mountCacheId(rule);
            }
            
            // lets verify if the cache is expired or not
            return verifyCache.then(expired=>{
                let lookForCache;
                if (expired && !forceFromCache) {
                    // in case it has expired, it resolves automatically
                    // with no results from cache
                    DSWManager.traceStep(event.request, 'Cache was expired');
                    lookForCache = Promise.resolve();
                    //logger.info('Cache expired for ', request.url);
                } else{
                    // if not expired, let's look for it!
                    lookForCache = caches.match(request);
                }
                
                // look for the request in the cache
                return lookForCache
                    .then(result=>{
                        // if it does not exist (cache could not be verified)
                        if (result && result.status != 200) {
                            DSWManager.traceStep(event.request,
                                'Fetch failed',
                                {
                                    url: request.url,
                                    status: result.status,
                                    statusText: result.statusText
                                });
                            // if it has expired in cache, failed requests for
                            // updates should return the previously cached data
                            // even if it has expired
                            if (expired) {
                                DSWManager.traceStep(
                                    request,
                                    'Forcing '+ (expired? 'expired ': '') +'result from cache'
                                );
                                // the true argument flag means it should come from cache, anyways
                                return cacheManager.get(rule, request, event, matching, true);
                            }
                            // look for rules that match for the request and its status
                            (DSWManager.rules[result.status]||[]).some((cur, idx)=>{
                                if (pathName.match(cur.rx)) {
                                    // if a rule matched for the status and request
                                    // and it tries to fetch a different source
                                    if (cur.action.fetch || cur.action.redirect) {
                                        DSWManager.traceStep(
                                            event.request,
                                            'Found fallback for failure',
                                            {
                                                rule: cur,
                                                url: request.url
                                            }
                                        );
                                        // problematic requests should
                                        result = goFetch(rule, request, event, matching);
                                        return true; // stopping the loop
                                    }
                                }
                            });
                            // we, then, return the promise of the failed result(for it
                            // could not be loaded and was not in cache)
                            return result;
                        } else {
                            // We will return the result, if successful, or
                            // fetch an anternative resource(or redirect)
                            // and treat both success and failure with the
                            // same "callback"
                            // In case it is a redirect, we also set the header to 302
                            // and really change the url of the response.
                            if (result) {
                                // when it comes from a redirect, we let the browser know about it
                                // or else...we simply return the result itself
                                if (request.url == event.request.url) {
                                    DSWManager.traceStep(
                                        event.request,
                                        'Result from cache',
                                        {
                                            url: event.request.url
                                        });
                                    return result;
                                } else {
                                    // coming from a redirect
                                    DSWManager.traceStep(
                                        event.request,
                                        'Must redirect',
                                        {
                                            from: event.request.url,
                                            to: request.url
                                        },
                                        false,
                                        {
                                            url: request.url,
                                            id: request.requestId,
                                            steps: request.traceSteps
                                        });
                                    return Response.redirect(request.url, 302);
                                }

                            } else if (actionType == 'redirect') {
                                // if this is supposed to redirect
                                DSWManager.traceStep(event.request, 'Must redirect', {
                                    from: event.request.url,
                                    to: request.url
                                });
                                return Response.redirect(request.url, 302);
                            } else {
                                // this is a "normal" request, let's deliver it
                                // but we will be using a new Request with some info
                                // to allow browsers to understand redirects in case
                                // it must be redirected later on
                                let treatFetch = function (response) {
                                    if (response.type == 'opaque') {
                                        // if it is a opaque response, let it go!
                                        if (rule.action.cache !== false) {
                                            DSWManager.traceStep(event.request, 'Added to cache (opaque)');
                                            return cacheManager.add(utils.createRequest(request, { mode: 'no-cors' }),
                                                                    cacheManager.mountCacheId(rule),
                                                                    response,
                                                                    rule);
                                        }
                                        return response;
                                    }
                                        
                                    if(!response.status){
                                        response.status = 404;
                                    }
                                    // after retrieving it, we cache it
                                    // if it was ok
                                    if (response.status == 200) {
                                        DSWManager.traceStep(event.request, 'Received result OK (200)');
                                        // if cache is not false, it will be added to cache
                                        if (rule.action.cache !== false) {
                                            // let's save it into cache
                                            DSWManager.traceStep(event.request, 'Saving into cache');
                                            return cacheManager.add(request,
                                                                    cacheManager.mountCacheId(rule),
                                                                    response,
                                                                    rule);
                                        }else{
                                            return response;
                                        }
                                    } else {
                                        // if it had expired, but could not be retrieved
                                        // from network, let's give its cache a chance!
                                        DSWManager.traceStep(event.request, 'Failed fetching');
                                        if (expired) {
                                            logger.warn('Cache for ',
                                                        request.url || request,
                                                        'had expired, but the updated version could not be retrieved from the network!\n',
                                                        'Delivering the outdated cached data');
                                            DSWManager.traceStep(event.request, 'Used expired cache', { note: 'Failed fetching, loading from cache even though it was expired' });
                                            return cacheManager.get(rule, request, event, matching, true);
                                        }
                                        // otherwise...let's see if there is a fallback
                                        // for the 404 requisition
                                        return DSWManager.treatBadPage(response, pathName, event);
                                    }
                                };
                                DSWManager.traceStep(event.request, 'Must fetch', {
                                    url: request.url,
                                    method: request.method
                                });
                                return goFetch(rule, request, event, matching)
                                        .then(treatFetch)
                                        .catch(treatFetch);
                            }
                        }
                    }); // end lookForCache
                
            }); // end verifyCache
        }
        default: {
            // also used in fetch actions
            return event;
        }
        }
    }
};

export default cacheManager;
