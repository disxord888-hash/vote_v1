/**
 * リアルタイム投票システム - Script.js
 * PeerJSを使用してサーバーレスなP2P通信を実現
 */

let peer = null;
let conn = null; // 参加者として接続した場合
let connections = []; // ホストとして受け入れた接続のリスト
let isHost = false;
let myPollData = {
    title: "",
    options: [],
    votes: {} // optionIndex -> count
};
let hasVoted = false;
let myIp = "unknown";
let votedIPs = new Set(); // ホストが管理する投票済みIPのセット

// UI要素
const screens = {
    menu: document.getElementById('menu-screen'),
    create: document.getElementById('create-screen'),
    host: document.getElementById('host-screen'),
    vote: document.getElementById('vote-screen')
};

const statusIndicator = document.getElementById('status-indicator');

// 初期化
// 初期化
function init() {
    setupEventListeners();

    // IPアドレスの取得 (非同期で裏で実行しておく)
    fetch('https://api.ipify.org?format=json')
        .then(res => res.json())
        .then(data => { myIp = data.ip; })
        .catch(e => {
            console.warn("IPの取得に失敗しました", e);
            // フォールバック
            myIp = localStorage.getItem('voter_id') || Math.random().toString(36).substring(2, 15);
            localStorage.setItem('voter_id', myIp);
        });

    // URLパラメータ(?id=xxx)の確認
    const urlParams = new URLSearchParams(window.location.search);
    const joinId = urlParams.get('id');
    if (joinId) {
        // パラメータがある場合は少し待ってから(UIの準備が整ってから)参加処理を走らせる
        setTimeout(() => {
            document.getElementById('join-id-input').value = joinId;
            isHost = false;
            startPeer(joinId);
        }, 100);
    }
}

function setupEventListeners() {
    // スクリーン遷移
    document.getElementById('btn-show-create').onclick = () => showScreen('create');
    document.querySelectorAll('.back-link').forEach(btn => {
        btn.onclick = () => showScreen('menu');
    });

    // オプションの追加
    document.getElementById('btn-add-option').onclick = () => {
        const container = document.getElementById('options-container');

        const row = document.createElement('div');
        row.className = 'option-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'option-input';
        input.placeholder = `選択肢 ${container.children.length + 1}`;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-remove-option';
        removeBtn.title = '削除';
        removeBtn.innerText = '×';
        removeBtn.onclick = () => {
            if (container.children.length > 2) {
                row.remove();
                updateOptionPlaceholders();
            } else {
                showToast("選択肢は最低2つ必要です");
            }
        };

        row.appendChild(input);
        row.appendChild(removeBtn);
        container.appendChild(row);
    };

    // 既存の削除ボタン
    document.querySelectorAll('.btn-remove-option').forEach(btn => {
        btn.onclick = function () {
            const container = document.getElementById('options-container');
            if (container.children.length > 2) {
                this.parentElement.remove();
                updateOptionPlaceholders();
            } else {
                showToast("選択肢は最低2つ必要です");
            }
        };
    });

    // ホストとして投票を開始
    document.getElementById('btn-create-poll').onclick = createPoll;

    // 参加者としてIDで参加
    document.getElementById('btn-join').onclick = joinPoll;

    // IDのコピー
    document.getElementById('btn-copy-id').onclick = () => {
        const idText = document.getElementById('display-id').innerText;
        navigator.clipboard.writeText(idText).then(() => {
            showToast("IDをコピーしました！");
        });
    };

    // URLのコピー
    document.getElementById('btn-copy-url').onclick = () => {
        const idText = document.getElementById('display-id').innerText;
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('id', idText);
        navigator.clipboard.writeText(currentUrl.toString()).then(() => {
            showToast("参加用URLをコピーしました！");
        });
    };

    // リアクションボタン
    document.querySelectorAll('.btn-reaction').forEach(btn => {
        btn.onclick = function () {
            const emoji = this.getAttribute('data-emoji');

            if (isHost) {
                // ホストの場合、接続している全員にリアクションを共有
                connections.forEach(c => {
                    c.send({
                        type: 'REACTION',
                        payload: emoji
                    });
                });
            } else {
                // 参加者の場合、ホストにリアクションを送信
                if (conn && conn.open) {
                    conn.send({
                        type: 'REACTION',
                        payload: emoji
                    });
                }
            }

            // 自身の画面にも表示
            showReaction(emoji);
        };
    });

    // 投票終了
    document.getElementById('btn-end-poll').onclick = endPoll;
}

/**
 * 投票を終了する
 */
function endPoll() {
    if (!confirm("投票を締め切りますか？")) return;

    // 全参加者に終了を通知
    connections.forEach(c => {
        c.send({
            type: 'POLL_END',
            payload: myPollData.votes
        });
    });

    // ホストのUI更新
    const endBtn = document.getElementById('btn-end-poll');
    endBtn.disabled = true;
    endBtn.innerText = "投票終了済み";
    endBtn.classList.remove('danger');

    showToast("投票を締め切りました");
}

/**
 * プレースホルダーの更新 (選択肢の番号振り直し)
 */
function updateOptionPlaceholders() {
    const inputs = document.querySelectorAll('.option-input');
    inputs.forEach((input, index) => {
        input.placeholder = `選択肢 ${index + 1}`;
    });
}

/**
 * 画面切り替え
 */
function showScreen(screenId) {
    Object.keys(screens).forEach(id => {
        screens[id].classList.remove('active');
    });
    screens[screenId].classList.add('active');
}

/**
 * ホスト：投票作成
 */
function createPoll() {
    const titleInput = document.getElementById('poll-title-input').value.trim();
    const optionInputs = document.querySelectorAll('.option-input');
    const options = Array.from(optionInputs)
        .map(input => input.value.trim())
        .filter(val => val !== "");

    if (!titleInput) return showToast("タイトルを入力してください");
    if (options.length < 2) return showToast("選択肢を2つ以上入力してください");

    myPollData.title = titleInput;
    myPollData.options = options;
    myPollData.votes = {};
    options.forEach((_, i) => myPollData.votes[i] = 0);

    isHost = true;
    startPeer();
}

/**
 * 参加者：既存の投票に参加
 */
function joinPoll() {
    const targetId = document.getElementById('join-id-input').value.trim();
    if (!targetId) return showToast("オンラインIDを入力してください");

    isHost = false;
    startPeer(targetId);
}

/**
 * PeerJSの開始
 */
function startPeer(targetId = null) {
    if (peer) peer.destroy();

    peer = new Peer({
        debug: 1
    });

    peer.on('open', (id) => {
        updateStatus("接続完了", "status-connected");

        if (isHost) {
            document.getElementById('display-id').innerText = id;
            document.getElementById('host-poll-title').innerText = myPollData.title;
            renderHostVoteOptions();
            renderResults();
            showScreen('host');
        } else {
            connectToHost(targetId);
        }
    });

    peer.on('connection', (connection) => {
        if (isHost) {
            setupHostConnection(connection);
        }
    });

    peer.on('error', (err) => {
        console.error(err);
        showToast("接続エラーが発生しました");
        updateStatus("エラー", "status-error");
    });
}

/**
 * 参加者：ホストに接続
 */
function connectToHost(hostId) {
    updateStatus("ホストに接続中...");
    conn = peer.connect(hostId);

    conn.on('open', () => {
        updateStatus("ホストに接続済み", "status-connected");
        // 接続完了を待つ（ホストからデータが来るはず）
    });

    conn.on('data', (data) => {
        if (data.type === 'POLL_INIT') {
            myPollData = data.payload;
            renderVoteOptions();
            showScreen('vote');
        } else if (data.type === 'RESULTS_UPDATE') {
            // 必要なら参加者側でも結果を表示できるが、今回はホストのみ
        } else if (data.type === 'REACTION') {
            showReaction(data.payload);
        } else if (data.type === 'POLL_END') {
            myPollData.votes = data.payload;
            showToast("ホストが投票を締め切りました！");

            // 参加者側にも結果を表示する
            showParticipantResults();
        } else if (data.type === 'ERROR') {
            alert(data.payload); // 重複投票アラートなど
            // 投票状態をリセット
            hasVoted = false;
            myVotedIndex = -1;
            document.getElementById('after-vote-msg').classList.add('hidden');
            document.getElementById('vote-options-list').classList.remove('hidden');
            document.getElementById('vote-instruction').innerText = "選択肢を1つ選んでください";
            document.getElementById('vote-instruction').classList.remove('hidden');
        }
    });

    conn.on('close', () => {
        showToast("ホストとの接続が切れました");
        showScreen('menu');
    });
}

/**
 * ホスト：新しい接続のセットアップ
 */
function setupHostConnection(connection) {
    connections.push(connection);
    updateVoterCount();

    connection.on('open', () => {
        // 初期データを送信
        connection.send({
            type: 'POLL_INIT',
            payload: {
                title: myPollData.title,
                options: myPollData.options
            }
        });
    });

    connection.on('data', (data) => {
        if (data.type === 'VOTE') {
            const { index, ip } = data.payload;

            // すでに投票済みのIPなら拒否
            if (votedIPs.has(ip)) {
                connection.send({
                    type: 'ERROR',
                    payload: 'すでにこの端末(IP)から投票されています'
                });
                return;
            }

            if (myPollData.votes[index] !== undefined) {
                myPollData.votes[index]++;
                votedIPs.add(ip); // IPを記録
                renderResults();
                broadcastResults();
            }
        } else if (data.type === 'REACTION') {
            // ホストの画面に表示
            showReaction(data.payload);
            // 他の参加者全員にも共有（送ってきた本人以外に送ってもよいが、今回は全員に送る）
            connections.forEach(c => {
                if (c !== connection) {
                    c.send({
                        type: 'REACTION',
                        payload: data.payload
                    });
                }
            });
        } else if (data.type === 'CANCEL_VOTE') {
            const { index, ip } = data.payload;
            if (myPollData.votes[index] !== undefined && myPollData.votes[index] > 0) {
                myPollData.votes[index]--;
                votedIPs.delete(ip); // IPの記録を削除
                renderResults();
                broadcastResults();
            }
        }
    });

    connection.on('close', () => {
        connections = connections.filter(c => c !== connection);
        updateVoterCount();
    });
}

/**
 * 参加者：投票肢のレンダリング
 */
function renderVoteOptions() {
    const container = document.getElementById('vote-options-list');
    const title = document.getElementById('vote-poll-title');

    title.innerText = myPollData.title;
    container.innerHTML = '';

    myPollData.options.forEach((opt, index) => {
        const btn = document.createElement('button');
        btn.className = 'vote-option-btn';
        btn.innerText = opt;
        btn.onclick = () => submitVote(index);
        container.appendChild(btn);
    });
}

let myVotedIndex = -1;

/**
 * 参加者：投票送信
 */
function submitVote(index) {
    if (hasVoted) return;

    myVotedIndex = index;
    conn.send({
        type: 'VOTE',
        payload: { index: index, ip: myIp }
    });

    hasVoted = true;
    document.getElementById('vote-options-list').classList.add('hidden');
    document.getElementById('vote-instruction').innerText = "投票しました（結果を待っています）";

    // 取り消しボタンを表示する
    let msgContainer = document.getElementById('after-vote-msg');
    msgContainer.innerHTML = `
        <div class="success-icon">✓</div>
        <p style="margin-bottom: 1rem;">投票が完了しました！</p>
        <button id="btn-cancel-vote" class="btn outline" style="margin: 0 auto;">投票を取り消す</button>
    `;
    msgContainer.classList.remove('hidden');

    // ★修正点：動的に追加したボタンのイベントリスナーを再設定
    setTimeout(() => {
        document.getElementById('btn-cancel-vote').onclick = cancelVote;
    }, 0);

    showToast("投票を受け付けました！");
}

/**
 * 参加者：投票の取り消し
 */
function cancelVote() {
    if (!hasVoted) return;

    conn.send({
        type: 'CANCEL_VOTE',
        payload: { index: myVotedIndex, ip: myIp }
    });

    hasVoted = false;
    myVotedIndex = -1;

    document.getElementById('after-vote-msg').classList.add('hidden');
    document.getElementById('vote-options-list').classList.remove('hidden');
    document.getElementById('vote-instruction').innerText = "選択肢を1つ選んでください";
    document.getElementById('vote-instruction').classList.remove('hidden');

    showToast("投票を取り消しました");
}

/**
 * ホスト：自身の投票肢のレンダリング
 */
function renderHostVoteOptions() {
    const container = document.getElementById('host-vote-options');
    container.innerHTML = '';

    if (hasVoted) {
        // 取り消しボタンを表示
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn outline';
        cancelBtn.style.margin = '0 auto';
        cancelBtn.innerText = '自身の投票を取り消す';
        cancelBtn.onclick = cancelHostVote;
        container.appendChild(cancelBtn);
    } else {
        myPollData.options.forEach((opt, index) => {
            const btn = document.createElement('button');
            btn.className = 'vote-option-btn';
            btn.innerText = opt;
            btn.onclick = () => submitHostVote(index);
            container.appendChild(btn);
        });
    }
}

/**
 * ホスト：自身の投票送信
 */
function submitHostVote(index) {
    if (hasVoted) return;

    if (votedIPs.has(myIp)) {
        showToast("すでにこの端末から投票されています\n(エラー用処理)"); // 実際には自分自身なので通るはず
        return;
    }

    if (myPollData.votes[index] !== undefined) {
        myPollData.votes[index]++;
        votedIPs.add(myIp);
        myVotedIndex = index;
        renderResults();
        broadcastResults();
    }

    hasVoted = true;
    renderHostVoteOptions(); // 取り消しボタンに切り替え
    showToast("あなたも投票しました！");
}

/**
 * ホスト：自身の投票取り消し
 */
function cancelHostVote() {
    if (!hasVoted) return;

    if (myPollData.votes[myVotedIndex] !== undefined && myPollData.votes[myVotedIndex] > 0) {
        myPollData.votes[myVotedIndex]--;
        votedIPs.delete(myIp);
        renderResults();
        broadcastResults();
    }

    hasVoted = true; // 意図的: hasVotedを一回trueにしたままですが、下の処理でfalseにします
    hasVoted = false;
    myVotedIndex = -1;

    // UIを投票ボタン一覧に戻す
    document.getElementById('host-vote-options').classList.remove('hidden');
    renderHostVoteOptions();
    showToast("投票を取り消しました");
}

/**
 * ホスト：結果のレンダリング
 */
function renderResults() {
    const container = document.getElementById('results-container');
    container.innerHTML = '';

    const totalVotes = Object.values(myPollData.votes).reduce((a, b) => a + b, 0);

    myPollData.options.forEach((opt, index) => {
        const count = myPollData.votes[index];
        const percent = totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);

        const item = document.createElement('div');
        item.className = 'result-item';
        item.innerHTML = `
            <div class="result-label">
                <span>${opt}</span>
                <span>${count} 票 (${percent}%)</span>
            </div>
            <div class="progress-bg">
                <div class="progress-fill" style="width: ${percent}%"></div>
            </div>
        `;
        container.appendChild(item);
    });
}

/**
 * 参加者：ホストが終了した後に結果を表示する
 */
function showParticipantResults() {
    // 投票中・待機中なら隠す
    document.getElementById('vote-options-list').classList.add('hidden');
    document.getElementById('vote-instruction').classList.add('hidden');
    document.getElementById('after-vote-msg').classList.add('hidden');

    const container = document.getElementById('participant-results-container');
    container.innerHTML = '<h3>最終結果</h3><br>';
    container.classList.remove('hidden');

    const totalVotes = Object.values(myPollData.votes).reduce((a, b) => a + b, 0);

    myPollData.options.forEach((opt, index) => {
        const count = myPollData.votes[index];
        const percent = totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);

        const item = document.createElement('div');
        item.className = 'result-item';
        item.innerHTML = `
            <div class="result-label">
                <span>${opt}</span>
                <span>${count} 票 (${percent}%)</span>
            </div>
            <div class="progress-bg">
                <div class="progress-fill" style="width: ${percent}%"></div>
            </div>
        `;
        container.appendChild(item);
    });
}

/**
 * ホ host: 結果を全員に再送 (オプション)
 */
function broadcastResults() {
    connections.forEach(c => {
        c.send({
            type: 'RESULTS_UPDATE',
            payload: myPollData.votes
        });
    });
}

function updateVoterCount() {
    document.getElementById('voter-count').innerText = `接続中の参加者: ${connections.length}人`;
}

function updateStatus(text, className = "") {
    statusIndicator.innerText = text;
    statusIndicator.className = className;
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerText = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3000);
}

/**
 * リアクション(絵文字)を画面に降らせる処理
 */
function showReaction(emoji) {
    let container = document.getElementById('reaction-container');

    // もしコンテナがなければbodyに直接追加する(フォールバック)
    if (!container) {
        container = document.createElement('div');
        container.id = 'reaction-container';
        container.className = 'reaction-container';
        document.body.appendChild(container);
    }

    const el = document.createElement('div');
    el.className = 'floating-emoji';
    el.innerText = emoji;

    // ランダムな横位置(10% ~ 90%の範囲)
    const leftPos = 10 + Math.random() * 80;
    el.style.left = `${leftPos}%`;

    // 少しランダムなアニメーション調整
    const duration = 2.5 + Math.random() * 1.5; // 2.5 ~ 4.0秒
    el.style.animationDuration = `${duration}s`;

    container.appendChild(el);

    // アニメーションが終わったら削除
    setTimeout(() => {
        el.remove();
    }, duration * 1000);
}

// 実行
init();
