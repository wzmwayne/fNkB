// ==UserScript==
// @name         NB全功能终极版：全量破解+登录拦截+文本替换
// @namespace    http://tampermonkey.net/
// @version      8.2
// @description  双层破解VIP，登录拦截，全局扫描，WebSocket修改，页面文本替换，可拖动日志面板
// @author       Ultimate
// @match        https://*.nobook.com/*
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ---------- 配置 ----------
    const LOGIN_URL_PATTERN = '/passport/v5/login/username';
    const MAX_QUEUE_SIZE = 50;
    const SCAN_INTERVAL = 2000; // 全局扫描间隔（毫秒）

    // ---------- 全局状态 ----------
    let enabled = true;
    let queue = [];
    let processing = false;
    let current = null;
    let processingLock = false;

    // UI 元素
    let logPanel = null;
    let logContentDiv = null;
    let statusSpan = null;
    let queueSpan = null;
    let logDiv = null;
    let isLogCollapsed = false;

    let loginModal = null;

    // 日志存储
    const logs = [];
    function addLog(msg, type = 'info') {
        try {
            const time = new Date().toLocaleTimeString();
            const prefix = type === 'modify' ? '[修改]' : (type === 'error' ? '[错误]' : '[信息]');
            const full = `[${time}] ${prefix} ${msg}`;
            logs.push(full);
            if (logs.length > 500) logs.shift();
            if (logDiv) {
                logDiv.value = logs.join('\n');
                logDiv.scrollTop = logDiv.scrollHeight;
            }
            console[type === 'error' ? 'error' : 'log'](`[NB终极] ${full}`);
        } catch (e) {
            // 防止日志本身出错影响主逻辑
        }
    }

    // ---------- 通用拖动函数（支持鼠标和触摸）----------
    function makeDraggable(element, handle) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        function onStart(e) {
            e.preventDefault();
            const clientX = e.clientX ?? (e.touches ? e.touches[0].clientX : 0);
            const clientY = e.clientY ?? (e.touches ? e.touches[0].clientY : 0);
            isDragging = true;
            startX = clientX;
            startY = clientY;
            const rect = element.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;

            function onMove(e) {
                if (!isDragging) return;
                e.preventDefault();
                const clientX = e.clientX ?? (e.touches ? e.touches[0].clientX : 0);
                const clientY = e.clientY ?? (e.touches ? e.touches[0].clientY : 0);
                const dx = clientX - startX;
                const dy = clientY - startY;
                element.style.left = (startLeft + dx) + 'px';
                element.style.top = (startTop + dy) + 'px';
                element.style.right = 'auto';
                element.style.bottom = 'auto';
            }

            function onEnd() {
                isDragging = false;
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onEnd);
                window.removeEventListener('touchmove', onMove);
                window.removeEventListener('touchend', onEnd);
            }

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onEnd);
            window.addEventListener('touchmove', onMove, { passive: false });
            window.addEventListener('touchend', onEnd);
        }

        handle.addEventListener('mousedown', onStart);
        handle.addEventListener('touchstart', onStart, { passive: false });
    }

    // ---------- 创建日志面板（可拖动、可缩放、可折叠）----------
    function createLogPanel() {
        if (document.getElementById('nb-log-panel')) return;

        logPanel = document.createElement('div');
        logPanel.id = 'nb-log-panel';
        logPanel.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            z-index: 2147483646;
            background: #fff;
            border: 1px solid #000;
            font-family: monospace;
            font-size: 12px;
            width: 550px;
            min-width: 300px;
            min-height: 120px;
            resize: both;
            overflow: auto;
            box-shadow: 2px 2px 5px rgba(0,0,0,0.2);
        `;

        const titleBar = document.createElement('div');
        titleBar.style.cssText = `
            background: #ddd;
            padding: 4px 6px;
            border-bottom: 1px solid #000;
            cursor: move;
            user-select: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        titleBar.innerHTML = '<span style="font-weight:bold;">🔓 NB终极破解日志</span>';

        const btnGroup = document.createElement('div');
        btnGroup.style.display = 'flex';
        btnGroup.style.gap = '4px';

        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = '−';
        toggleBtn.style.cssText = 'border:1px solid #000;background:#eee;padding:0 6px;cursor:pointer;font-weight:bold;';
        btnGroup.appendChild(toggleBtn);

        titleBar.appendChild(btnGroup);
        logPanel.appendChild(titleBar);

        logContentDiv = document.createElement('div');
        logContentDiv.style.cssText = 'padding:5px;';

        const statusLine = document.createElement('div');
        statusSpan = document.createElement('span');
        queueSpan = document.createElement('span');
        const toggleCrackBtn = document.createElement('button');
        toggleCrackBtn.textContent = '暂停破解';
        toggleCrackBtn.style.cssText = 'border:1px solid #000;background:#eee;padding:2px 6px;margin-left:10px;';
        toggleCrackBtn.onclick = () => {
            enabled = !enabled;
            toggleCrackBtn.textContent = enabled ? '暂停破解' : '启用破解';
            statusSpan.textContent = enabled ? '🟢 破解中' : '⏸️ 已暂停';
            addLog(enabled ? '破解已启用' : '破解已暂停');
            if (enabled && !processing) processNext();
        };
        statusLine.appendChild(statusSpan);
        statusLine.appendChild(document.createTextNode(' 队列: '));
        statusLine.appendChild(queueSpan);
        statusLine.appendChild(toggleCrackBtn);
        logContentDiv.appendChild(statusLine);

        logDiv = document.createElement('textarea');
        logDiv.readOnly = true;
        logDiv.style.cssText = 'width:100%;height:350px;margin-top:5px;border:1px solid #000;font-size:10px;font-family:monospace;';
        logContentDiv.appendChild(logDiv);

        logPanel.appendChild(logContentDiv);
        document.body.appendChild(logPanel);

        // 绑定折叠事件（修复 Bug 4：显式传入 e）
        toggleBtn.onclick = function(e) {
            e.stopPropagation();
            isLogCollapsed = !isLogCollapsed;
            logContentDiv.style.display = isLogCollapsed ? 'none' : 'block';
            toggleBtn.textContent = isLogCollapsed ? '+' : '−';
            logPanel.style.minHeight = isLogCollapsed ? '80px' : '200px';
        };

        // 使标题栏可拖动
        makeDraggable(logPanel, titleBar);

        statusSpan.textContent = '🟢 破解中';
        queueSpan.textContent = '0';
    }

    function waitForBody() {
        if (document.body) createLogPanel();
        else setTimeout(waitForBody, 30);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForBody);
    } else {
        waitForBody();
    }

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('显示日志窗口', () => {
            if (logPanel) logPanel.style.display = 'block';
            else createLogPanel();
        });
    }

    // ---------- 登录弹窗（可拖动）修复 Bug 2 ----------
    function showLoginModal(title, content, onConfirm, onCancel, showCancel = true) {
        if (loginModal) loginModal.remove();

        loginModal = document.createElement('div');
        loginModal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 2147483647;
            background: rgba(0,0,0,0.3);
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        const box = document.createElement('div');
        // 修复 Bug 2：添加 position: relative 并重置 margin，使拖动偏移生效
        box.style.cssText = `
            position: relative;
            background: #fff;
            border: 2px solid #000;
            padding: 15px;
            max-width: 500px;
            min-width: 350px;
            font-family: monospace;
            font-size: 13px;
            margin: 0;
        `;

        const titleBar = document.createElement('div');
        titleBar.style.cssText = `
            background: #ddd;
            padding: 4px 6px;
            margin: -15px -15px 10px -15px;
            border-bottom: 1px solid #000;
            cursor: move;
            user-select: none;
            text-align: center;
            font-weight: bold;
        `;
        titleBar.textContent = title;
        box.appendChild(titleBar);

        const pre = document.createElement('pre');
        pre.style.cssText = 'background:#f5f5f5;border:1px solid #aaa;padding:8px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;';
        pre.textContent = content;
        box.appendChild(pre);

        const btnLine = document.createElement('div');
        btnLine.style.cssText = 'margin-top:15px;display:flex;gap:10px;justify-content:center;';
        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = onConfirm ? '确认登录' : '放行';
        confirmBtn.style.cssText = 'border:1px solid #000;background:#eee;padding:5px 20px;cursor:pointer;font-weight:bold;';
        confirmBtn.onclick = () => {
            if (onConfirm) onConfirm();
            loginModal.remove();
            loginModal = null;
        };
        btnLine.appendChild(confirmBtn);

        if (showCancel) {
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = onCancel ? '取消登录' : '舍弃';
            cancelBtn.style.cssText = 'border:1px solid #000;background:#eee;padding:5px 20px;cursor:pointer;';
            cancelBtn.onclick = () => {
                if (onCancel) onCancel();
                loginModal.remove();
                loginModal = null;
            };
            btnLine.appendChild(cancelBtn);
        }
        box.appendChild(btnLine);
        loginModal.appendChild(box);
        document.body.appendChild(loginModal);

        makeDraggable(box, titleBar);
    }

    // ---------- 核心修改函数 ----------
    function applyStringReplacements(text) {
        if (typeof text !== 'string') return { text, changed: false, changes: [] };
        let modified = text;
        let changed = false;
        const changeDetails = [];

        const replacements = [
            { pattern: /"isLock"\s*:\s*true/gi, replacement: '"isLock": false', desc: 'isLock: true → false' },
            { pattern: /"isVip"\s*:\s*true/gi, replacement: '"isVip": false', desc: 'isVip: true → false' },
            { pattern: /"needVip"\s*:\s*true/gi, replacement: '"needVip": false', desc: 'needVip: true → false' },
            { pattern: /"onlyVip"\s*:\s*true/gi, replacement: '"onlyVip": false', desc: 'onlyVip: true → false' },
            { pattern: /"isHidden"\s*:\s*true/gi, replacement: '"isHidden": false', desc: 'isHidden: true → false' },
            { pattern: /"hidden"\s*:\s*true/gi, replacement: '"hidden": false', desc: 'hidden: true → false' },
            { pattern: /"lock"\s*:\s*true/gi, replacement: '"lock": false', desc: 'lock: true → false' },
            { pattern: /"locked"\s*:\s*true/gi, replacement: '"locked": false', desc: 'locked: true → false' },
            { pattern: /"premium"\s*:\s*true/gi, replacement: '"premium": false', desc: 'premium: true → false' },
            { pattern: /"isFreeEq"\s*:\s*false/gi, replacement: '"isFreeEq": true', desc: 'isFreeEq: false → true' },
            { pattern: /"visible"\s*:\s*false/gi, replacement: '"visible": true', desc: 'visible: false → true' },
            { pattern: /"show"\s*:\s*false/gi, replacement: '"show": true', desc: 'show: false → true' },
            { pattern: /"enabled"\s*:\s*false/gi, replacement: '"enabled": true', desc: 'enabled: false → true' },
            { pattern: /"vip"\s*:\s*[1-9][0-9]*/gi, replacement: '"vip": 0', desc: 'vip: X → 0' },
            { pattern: /"price"\s*:\s*[0-9]+/gi, replacement: '"price": 0', desc: 'price: X → 0' },
            { pattern: /"cost"\s*:\s*[0-9]+/gi, replacement: '"cost": 0', desc: 'cost: X → 0' },
            { pattern: /"coin"\s*:\s*[0-9]+/gi, replacement: '"coin": 0', desc: 'coin: X → 0' },
            { pattern: /"point"\s*:\s*[0-9]+/gi, replacement: '"point": 0', desc: 'point: X → 0' },
            { pattern: /"credit"\s*:\s*[0-9]+/gi, replacement: '"credit": 0', desc: 'credit: X → 0' },
            { pattern: /"channel_vip"\s*:\s*[1-9][0-9]*/gi, replacement: '"channel_vip": 0', desc: 'channel_vip: X → 0' },
            { pattern: /"app_resource_vip"\s*:\s*[1-9][0-9]*/gi, replacement: '"app_resource_vip": 0', desc: 'app_resource_vip: X → 0' },
            { pattern: /"app_resource"\s*:\s*[1-9][0-9]*/gi, replacement: '"app_resource": 0', desc: 'app_resource: X → 0' }
        ];

        // 修复 Bug 1：直接替换并比较结果
        replacements.forEach(r => {
            const before = modified;
            modified = modified.replace(r.pattern, r.replacement);
            if (before !== modified) {
                changed = true;
                changeDetails.push(r.desc);
            }
        });

        return { text: modified, changed, changes: changeDetails };
    }

    // 修复 Bug 3：使用 WeakSet 防止循环引用
    function deepUnlock(obj, path = 'root') {
        if (!obj || typeof obj !== 'object') return { obj, changes: [] };
        const visited = new WeakSet();
        const changes = [];

        function process(target, currentPath) {
            if (!target || typeof target !== 'object') return;
            if (visited.has(target)) return; // 防止循环
            visited.add(target);
            if (Array.isArray(target)) {
                target.forEach((item, idx) => process(item, `${currentPath}[${idx}]`));
                return;
            }
            for (let key in target) {
                if (!target.hasOwnProperty(key)) continue;
                const val = target[key];
                const lowerKey = key.toLowerCase();

                if (typeof val === 'boolean') {
                    if (/(vip|lock|hidden|hide|disabled|premium|onlyvip|needvip)/.test(lowerKey) && val !== false) {
                        changes.push({ path: `${currentPath}.${key}`, old: val, new: false });
                        target[key] = false;
                    } else if (/(free|unlock|visible|show|enable|active|canuse)/.test(lowerKey) && val !== true) {
                        changes.push({ path: `${currentPath}.${key}`, old: val, new: true });
                        target[key] = true;
                    }
                }
                if (typeof val === 'number') {
                    if (/(price|cost|coin|point|vipscore|credit|vip|channel_vip|app_resource)/.test(lowerKey) && val > 0) {
                        changes.push({ path: `${currentPath}.${key}`, old: val, new: 0 });
                        target[key] = 0;
                    }
                }
                if (key === 'eqName' && typeof val === 'string' && !target.hasOwnProperty('isFreeEq')) {
                    target.isFreeEq = true;
                    changes.push({ path: `${currentPath}.isFreeEq`, old: undefined, new: true });
                }
                if (target[key] && typeof target[key] === 'object') {
                    process(target[key], `${currentPath}.${key}`);
                }
            }
        }

        process(obj, path);
        return { obj, changes };
    }

    // ---------- 页面文本替换 ----------
    const TEXT_REPLACEMENTS = [
        { pattern: /vip/gi, replacement: '已破解，正处于免费器材模式' },
        { pattern: /nobook/gi, replacement: 'fNkB_free' },
        { pattern: /\bnb\b/gi, replacement: 'fNkB_free' }
    ];

    function replaceTextInNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            let text = node.nodeValue;
            let changed = false;
            for (let rule of TEXT_REPLACEMENTS) {
                if (rule.pattern.test(text)) {
                    text = text.replace(rule.pattern, rule.replacement);
                    changed = true;
                }
            }
            if (changed) {
                node.nodeValue = text;
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
            for (let child of node.childNodes) {
                replaceTextInNode(child);
            }
        }
    }

    function replacePageText() {
        if (document.body) {
            replaceTextInNode(document.body);
        }
    }

    const textObserver = new MutationObserver(mutations => {
        for (let mut of mutations) {
            for (let node of mut.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    replaceTextInNode(node);
                } else if (node.nodeType === Node.TEXT_NODE) {
                    replaceTextInNode(node);
                }
            }
        }
    });

    function startTextObserver() {
        if (document.body) {
            textObserver.observe(document.body, { childList: true, subtree: true });
            replacePageText();
        } else {
            setTimeout(startTextObserver, 100);
        }
    }

    // ---------- 全局扫描 ----------
    function scanAndPatchScripts() {
        const scripts = document.querySelectorAll('script:not([data-nb-scanned])');
        scripts.forEach(script => {
            if (script.textContent) {
                const result = applyStringReplacements(script.textContent);
                if (result.changed) {
                    script.textContent = result.text;
                    script.setAttribute('data-nb-scanned', 'true');
                    addLog(`修改内联脚本: ${result.changes.join('; ')}`, 'modify');
                }
            }
            script.setAttribute('data-nb-scanned', 'true');
        });
    }

    function scanGlobalVariables() {
        const globals = [
            '__INITIAL_STATE__', 'pageData', 'equipmentData', 'store', 'app',
            'vuex', '__NUXT__', 'resourceData', 'experimentData', 'vipData',
            'userInfo', 'equipments', 'data'
        ];
        globals.forEach(name => {
            try {
                if (unsafeWindow[name] && typeof unsafeWindow[name] === 'object') {
                    const result = deepUnlock(unsafeWindow[name], name);
                    if (result.changes.length > 0) {
                        const changeStrs = result.changes.map(c => `${c.path}: ${c.old} → ${c.new}`);
                        addLog(`修改全局变量 ${name}: ${changeStrs.join('; ')}`, 'modify');
                    }
                }
            } catch (e) {
                // 忽略单个变量访问错误
            }
        });
    }

    const scriptObserver = new MutationObserver(mutations => {
        mutations.forEach(mut => {
            mut.addedNodes.forEach(node => {
                if (node.nodeType === 1 && node.tagName === 'SCRIPT') {
                    if (node.textContent && !node.hasAttribute('data-nb-scanned')) {
                        const result = applyStringReplacements(node.textContent);
                        if (result.changed) {
                            node.textContent = result.text;
                            addLog(`修改动态脚本: ${result.changes.join('; ')}`, 'modify');
                        }
                        node.setAttribute('data-nb-scanned', 'true');
                    }
                }
            });
        });
    });

    function startGlobalObserver() {
        if (document.documentElement) {
            scriptObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    setInterval(() => {
        scanGlobalVariables();
        scanAndPatchScripts();
        replacePageText();
    }, SCAN_INTERVAL);

    // ---------- WebSocket 拦截 ----------
    const OriginalWebSocket = unsafeWindow.WebSocket;
    if (OriginalWebSocket) {
        unsafeWindow.WebSocket = function(...args) {
            const ws = new OriginalWebSocket(...args);
            const originalAddEventListener = ws.addEventListener;
            ws.addEventListener = function(type, listener) {
                if (type === 'message') {
                    const wrappedListener = function(event) {
                        if (typeof event.data === 'string') {
                            const result = applyStringReplacements(event.data);
                            if (result.changed) {
                                addLog(`修改 WebSocket 消息: ${result.changes.join('; ')}`, 'modify');
                                Object.defineProperty(event, 'data', { value: result.text });
                            }
                        }
                        listener.call(this, event);
                    };
                    return originalAddEventListener.call(this, type, wrappedListener);
                }
                return originalAddEventListener.call(this, type, listener);
            };
            Object.defineProperty(ws, 'onmessage', {
                set: function(listener) {
                    originalAddEventListener.call(this, 'message', function(event) {
                        if (typeof event.data === 'string') {
                            const result = applyStringReplacements(event.data);
                            if (result.changed) {
                                addLog(`修改 WebSocket 消息: ${result.changes.join('; ')}`, 'modify');
                                Object.defineProperty(event, 'data', { value: result.text });
                            }
                        }
                        listener.call(this, event);
                    });
                }
            });
            return ws;
        };
        unsafeWindow.WebSocket.prototype = OriginalWebSocket.prototype;
        addLog('WebSocket 拦截已启用');
    }

    // ---------- 队列处理 ----------
    function processNext() {
        if (processingLock) return;
        processingLock = true;

        try {
            if (!enabled || processing || queue.length === 0) {
                processing = false;
                current = null;
                updateQueueDisplay();
                return;
            }

            const next = queue.shift();
            if (!next) {
                processing = false;
                current = null;
                updateQueueDisplay();
                return;
            }

            current = next;
            processing = true;

            if (current.request.url.includes(LOGIN_URL_PATTERN)) {
                handleLoginIntercept(current);
            } else {
                autoProcessCrack(current);
            }
        } catch (e) {
            addLog(`队列异常: ${e.message}`, 'error');
            current = null;
            processing = false;
        } finally {
            processingLock = false;
            updateQueueDisplay();
        }
    }

    function updateQueueDisplay() {
        if (queueSpan) queueSpan.textContent = queue.length;
    }

    function autoProcessCrack(item) {
        const { resolve, request, stage } = item;
        try {
            if (stage === 'request') {
                resolve();
                addLog(`请求放行: ${request.method} ${request.url}`);
            } else {
                let responseText = request.responseText;
                let originalObj = null;
                try { originalObj = JSON.parse(responseText); } catch(e) {}
                addLog(`📥 拦截响应: ${request.url}`);

                const strResult = applyStringReplacements(responseText);
                let workingText = strResult.text;
                if (strResult.changed) {
                    addLog(`   [第1层] 字符串替换: ${strResult.changes.join('; ')}`, 'modify');
                } else {
                    addLog(`   [第1层] 无字符串修改`);
                }

                let workingObj;
                try {
                    workingObj = JSON.parse(workingText);
                } catch (e) {
                    workingObj = originalObj || {};
                }

                const deepResult = deepUnlock(workingObj);
                if (deepResult.changes.length > 0) {
                    const changeStrs = deepResult.changes.map(c => `${c.path}: ${c.old} → ${c.new}`);
                    addLog(`   [第2层] 深度修改: ${changeStrs.join('; ')}`, 'modify');
                } else {
                    addLog(`   [第2层] 无深度修改`);
                }

                const finalText = JSON.stringify(workingObj);
                resolve(finalText);
            }
        } catch (e) {
            addLog(`自动破解异常: ${e.message}`, 'error');
            if (stage === 'response') resolve(request.responseText);
            else resolve();
        } finally {
            current = null;
            processing = false;
            setTimeout(() => processNext(), 10);
        }
    }

    function handleLoginIntercept(item) {
        const { resolve, reject, request, stage } = item;

        if (stage === 'request') {
            let bodyStr = request.body || '';
            let displayStr = bodyStr;
            try {
                const json = JSON.parse(bodyStr);
                const username = json.username || '';
                const password = json.password || '';
                displayStr = `用户名: ${username}\n密码: ${'•'.repeat(password.length)}\n\n完整请求:\n${JSON.stringify(json, null, 2)}`;
            } catch (e) {
                displayStr = bodyStr || '(无请求体)';
            }

            showLoginModal('📤 登录请求', displayStr,
                () => {
                    addLog(`用户确认发送登录请求: ${request.url}`);
                    resolve();
                    current = null;
                    processing = false;
                    setTimeout(() => processNext(), 10);
                },
                () => {
                    addLog(`用户取消登录请求: ${request.url}`);
                    reject(new Error('用户取消登录'));
                    current = null;
                    processing = false;
                    setTimeout(() => processNext(), 10);
                },
                true
            );
        } else {
            const responseText = request.responseText;
            let displayText = responseText;
            let isSuccess = false;
            try {
                const json = JSON.parse(responseText);
                isSuccess = json.code === 200 || json.auth_token;
                displayText = JSON.stringify(json, null, 2);
            } catch (e) {}

            const title = isSuccess ? '✅ 登录成功' : '❌ 登录失败';
            showLoginModal(`${title} - 响应内容`, displayText,
                () => {
                    addLog(`用户放行登录响应: ${request.url}`);
                    resolve(responseText);
                    current = null;
                    processing = false;
                    setTimeout(() => processNext(), 10);
                },
                () => {
                    addLog(`用户舍弃登录响应: ${request.url}`);
                    reject(new Error('用户舍弃登录响应'));
                    current = null;
                    processing = false;
                    setTimeout(() => processNext(), 10);
                },
                true
            );
        }
    }

    function safeEnqueue(item) {
        if (!enabled) {
            if (item.stage === 'request') item.resolve();
            else item.resolve(item.request.responseText);
            return;
        }
        if (queue.length >= MAX_QUEUE_SIZE) {
            addLog(`队列已满，强制放行: ${item.request.url}`, 'error');
            if (item.stage === 'request') item.resolve();
            else item.resolve(item.request.responseText);
            return;
        }
        queue.push(item);
        updateQueueDisplay();
        if (!processing) processNext();
    }

    // ---------- 拦截 fetch ----------
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(input, init) {
        const url = typeof input === 'string' ? input : input.url;
        const method = (init && init.method) || 'GET';
        const body = init && init.body;

        if (!enabled) return originalFetch.call(this, input, init);

        try {
            // 请求拦截
            await new Promise((resolve, reject) => {
                safeEnqueue({ resolve, reject, request: { type: 'fetch', url, method, body }, stage: 'request' });
            });
        } catch (e) {
            // 修复 Bug 6：用户取消请求，返回 403 响应以避免页面崩溃
            addLog(`fetch 请求被用户取消: ${url}`, 'error');
            return new Response(JSON.stringify({ error: 'Request cancelled by user' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        let resp;
        try {
            resp = await originalFetch.call(this, input, init);
        } catch (e) {
            throw e;
        }

        const clone = resp.clone();
        let text;
        try {
            text = await clone.text();
        } catch (e) {
            // 如果无法读取文本，直接返回原始响应
            return resp;
        }
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
            return resp;
        }

        let modifiedText;
        try {
            modifiedText = await new Promise((resolve, reject) => {
                safeEnqueue({
                    resolve, reject,
                    request: { type: 'fetch', url, method, responseText: text, status: resp.status, statusText: resp.statusText, headers: resp.headers, originalResponse: resp },
                    stage: 'response'
                });
            });
        } catch (e) {
            // 用户舍弃响应，返回原始响应
            return resp;
        }

        if (modifiedText && modifiedText !== text) {
            return new Response(modifiedText, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
        }
        return resp;
    };

    // ---------- 拦截 XHR ----------
    const XHR = unsafeWindow.XMLHttpRequest;
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function(method, url, ...rest) {
        this._method = method;
        this._url = url;
        return originalOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function(...args) {
        const self = this;
        const body = args[0];
        const method = self._method;
        const url = self._url;

        if (!enabled) return originalSend.call(this, ...args);

        new Promise((resolve, reject) => {
            safeEnqueue({ resolve, reject, request: { type: 'xhr', url, method, body }, stage: 'request' });
        }).then(() => {
            originalSend.call(self, ...args);
        }).catch(() => {
            if (self.onerror) self.onerror(new Error('请求被舍弃'));
            self.dispatchEvent(new Event('error'));
        });

        // 修复 Bug 5：使用 _handled 标记防止重复，并移除监听器
        function readyStateHandler() {
            if (self.readyState === 4) {
                if (self._handled) return;
                self._handled = true;
                self.removeEventListener('readystatechange', readyStateHandler);

                const responseText = self.responseText;
                const contentType = self.getResponseHeader('content-type') || '';
                if (!contentType.includes('application/json') && !contentType.includes('text/plain')) return;

                new Promise((resolve, reject) => {
                    safeEnqueue({
                        resolve: (finalResp) => {
                            if (finalResp && finalResp !== responseText) {
                                Object.defineProperty(self, 'responseText', { value: finalResp, configurable: true });
                                Object.defineProperty(self, 'response', { value: finalResp, configurable: true });
                            }
                            if (self.onload) self.onload();
                            if (self.onreadystatechange) self.onreadystatechange.call(self);
                        },
                        reject: (err) => {
                            if (self.onerror) self.onerror(err);
                            self.dispatchEvent(new Event('error'));
                        },
                        request: { type: 'xhr', url, method, responseText, status: self.status, statusText: self.statusText, headers: self.getAllResponseHeaders() },
                        stage: 'response'
                    });
                });
            }
        }
        self.addEventListener('readystatechange', readyStateHandler);
    };

    // 启动所有监听
    startGlobalObserver();
    startTextObserver();
    scanAndPatchScripts();
    scanGlobalVariables();

    addLog('终极完整版已启动（全量扫描 + 网络拦截 + WebSocket）');
})();
