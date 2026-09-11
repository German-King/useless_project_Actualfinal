'use strict';

// =============================================
// STATE
// =============================================

// =============================================
// CONFIG - Centralized settings
// =============================================
const CONFIG = {
  DND_BASE_COST: 100,
  DND_BETRAYAL_MULTIPLIER: 0.5,
  BRIBE_BETRAYAL_CHANCE: 0.3,
  MOOD_CHECK_INTERVAL: 5000
};

const State = {
  data: {
    alarm: null,
    bankBalance: 1900,
    dnd: false,
    mrClockEmployed: true,
    employeeSince: '2026-09-11',
    stats: {
      totalAlarms: 0,
      successfulAlarms: 0,
      missedAlarms: 0,
      delayedAlarms: 0,
      bribesReceived: 0,
      bribeBetrayals: 0
    },
    alarmHistory: [],
    customRingtone: null,
    mrClockMood: 'neutral',
    achievements: []
  },

  save() {
    try {
      localStorage.setItem('mrclock_state_v2', JSON.stringify(this.data));
    } catch(e) { console.warn('Save failed:', e); }
  },

  load() {
    try {
      const raw = localStorage.getItem('mrclock_state_v2');
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = { ...this.data, ...parsed };
      }
    } catch(e) { console.warn('Load failed:', e); }
  },
};

// =============================================
// NATIVE INTEGRATION (CAPACITOR / ANDROID)
// =============================================

const Native = {
  isAvailable() {
    return typeof window.Capacitor !== 'undefined' && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform();
  },

  async init() {
    const unlockAudio = () => {
      Sound._getCtx();
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
    };
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('touchstart', unlockAudio, { passive: true });

    if (!this.isAvailable()) return;

    try {
      const plugins = window.Capacitor.Plugins;
      if (plugins && plugins.StatusBar) {
        await plugins.StatusBar.setBackgroundColor({ color: '#000000' });
        await plugins.StatusBar.setStyle({ style: 'DARK' });
      }
    } catch (e) {
      console.warn('Native StatusBar init error:', e);
    }

    try {
      const plugins = window.Capacitor.Plugins;
      if (plugins && plugins.App) {
        plugins.App.addListener('backButton', () => {
          const openModal = document.querySelector('.modal.visible');
          if (openModal) {
            openModal.classList.remove('visible');
            return;
          }
          if (AlarmScreen.isRinging) {
            AlarmScreen.onStop();
            return;
          }
          if (RadialMenu.isOpen) {
            RadialMenu.close();
            return;
          }
          plugins.App.exitApp();
        });
      }
    } catch (e) {
      console.warn('Native App backButton error:', e);
    }

    try {
      const plugins = window.Capacitor.Plugins;
      if (plugins && plugins.LocalNotifications) {
        await plugins.LocalNotifications.requestPermissions();
      }
    } catch (e) {
      console.warn('Native LocalNotifications permission error:', e);
    }
  },

  hapticTick() {
    if (this.isAvailable() && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) {
      try { window.Capacitor.Plugins.Haptics.selectionChanged(); } catch (e) {}
    } else if (navigator.vibrate) {
      navigator.vibrate(8);
    }
  },

  hapticSnap() {
    if (this.isAvailable() && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) {
      try { window.Capacitor.Plugins.Haptics.impact({ style: 'LIGHT' }); } catch (e) {}
    } else if (navigator.vibrate) {
      navigator.vibrate(15);
    }
  },

  hapticCoin() {
    if (this.isAvailable() && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) {
      try { window.Capacitor.Plugins.Haptics.impact({ style: 'MEDIUM' }); } catch (e) {}
    } else if (navigator.vibrate) {
      navigator.vibrate([20, 50, 20]);
    }
  },

  hapticError() {
    if (this.isAvailable() && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) {
      try { window.Capacitor.Plugins.Haptics.notification({ type: 'ERROR' }); } catch (e) {}
    } else if (navigator.vibrate) {
      navigator.vibrate([40, 40, 40]);
    }
  },

  hapticAlarm() {
    if (this.isAvailable() && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) {
      try { window.Capacitor.Plugins.Haptics.vibrate({ duration: 1000 }); } catch (e) {}
    } else if (navigator.vibrate) {
      navigator.vibrate([400, 200, 400, 200, 800]);
    }
  },

  async scheduleNotification(alarm) {
    if (!this.isAvailable() || !window.Capacitor.Plugins || !window.Capacitor.Plugins.LocalNotifications) return;
    try {
      const LocalNotifications = window.Capacitor.Plugins.LocalNotifications;
      await LocalNotifications.cancel({ notifications: [{ id: 1001 }] });

      let targetHour = alarm.hour12 % 12;
      if (alarm.ampm === 'PM') targetHour += 12;

      const now = new Date();
      const targetDate = new Date();
      targetDate.setHours(targetHour, alarm.minute, 0, 0);
      if (targetDate <= now) {
        targetDate.setDate(targetDate.getDate() + 1);
      }

      const hDisp = alarm.hour12 === 0 ? 12 : alarm.hour12;
      const mDisp = String(alarm.minute).padStart(2, '0');

      await LocalNotifications.schedule({
        notifications: [
          {
            id: 1001,
            title: '⏰ Mr Clock',
            body: `Wake up! Your ${hDisp}:${mDisp} ${alarm.ampm} alarm is ringing!`,
            schedule: { at: targetDate, allowWhileIdle: true },
            sound: 'beep.wav'
          }
        ]
      });
    } catch (e) {
      console.warn('scheduleNotification error:', e);
    }
  },

  async cancelNotification() {
    if (!this.isAvailable() || !window.Capacitor.Plugins || !window.Capacitor.Plugins.LocalNotifications) return;
    try {
      await window.Capacitor.Plugins.LocalNotifications.cancel({ notifications: [{ id: 1001 }] });
    } catch (e) {}
  }
};

// =============================================
// SOUND ENGINE
// =============================================

const Sound = {
  audioCtx: null,
  oscillators: [],
  beepRepeatTimer: null,
  customAudio: null,

  _getCtx() {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  },

  playTick() {
    Native.hapticTick();
    try {
      const ctx = this._getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(300, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.03);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 0.03);
      osc.start();
      osc.stop(ctx.currentTime + 0.03);
    } catch(e) {}
  },

  playSnap() {
    Native.hapticSnap();
    try {
      const ctx = this._getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);
    } catch(e) {}
  },

  playCoin() {
    Native.hapticCoin();
    try {
      const ctx = this._getCtx();
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(987.77, now);
      gain1.gain.setValueAtTime(0.25, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc1.start(now);
      osc1.stop(now + 0.15);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(1318.51, now + 0.08);
      gain2.gain.setValueAtTime(0.3, now + 0.08);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.45);
    } catch(e) {}
  },

  playError() {
    Native.hapticError();
    try {
      const ctx = this._getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(100, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch(e) {}
  },

  playAlarm() {
    this.stopAlarm();

    if (State.data.customRingtone) {
      this._playCustomRingtone();
      return;
    }

    try {
      const ctx = this._getCtx();
      const scheduleBeeps = () => {
        const beepDuration = 0.12;
        const beepGap = 0.08;
        const groupGap = 0.6;
        let t = ctx.currentTime;

        for (let i = 0; i < 3; i++) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = 'sine';
          osc.frequency.value = i % 2 === 0 ? 880 : 1200;
          gain.gain.setValueAtTime(0.4, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + beepDuration);
          osc.start(t);
          osc.stop(t + beepDuration);
          this.oscillators.push(osc);
          t += beepDuration + beepGap;
        }

        this.beepRepeatTimer = setTimeout(() => {
          if (AlarmScreen.isRinging) scheduleBeeps();
        }, (t - ctx.currentTime + groupGap) * 1000);
      };
      scheduleBeeps();
    } catch(e) {}
  },

  _playCustomRingtone() {
    try {
      if (!this.customAudio) {
        this.customAudio = new Audio(State.data.customRingtone);
        this.customAudio.loop = true;
      }
      this.customAudio.currentTime = 0;
      this.customAudio.play();
    } catch(e) {
      this._playDefaultAlarm();
    }
  },

  stopAlarm() {
    this.oscillators.forEach(o => { try { o.stop(); } catch(e){} });
    this.oscillators = [];
    clearTimeout(this.beepRepeatTimer);
    if (this.customAudio) {
      this.customAudio.pause();
      this.customAudio.currentTime = 0;
    }
  }
};

// =============================================
// TOAST
// =============================================

const Toast = {
  timer: null,
  show(msg, type = 'info') {
    const el = document.getElementById('dndToast');
    if (!el) return;
    el.textContent = msg;
    el.className = `dnd-toast show ${type}`;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      el.classList.remove('show');
    }, 4000);
  }
};

// =============================================
// ACHIEVEMENTS SYSTEM
// =============================================

const Achievements = {
  definitions: [
    { id: 'first-alarm', title: '🎯 First Alarm', desc: 'Set your first alarm', check: (stats) => stats.totalAlarms >= 1 },
    { id: 'first-bribe', title: '💰 Bribery Begins', desc: 'Bribe Mr Clock for the first time', check: (stats) => stats.bribesReceived >= 1 },
    { id: 'chronic-briber', title: '💸 Chronic Briber', desc: 'Bribe Mr Clock 10 times', check: (stats) => stats.bribesReceived >= 10 },
    { id: 'betrayed-once', title: '😈 First Betrayal', desc: 'Experience Mr Clock\'s betrayal', check: (stats) => stats.bribeBetrayals >= 1 },
    { id: 'betrayal-king', title: '👑 Betrayal King', desc: 'Get betrayed 5 times', check: (stats) => stats.bribeBetrayals >= 5 },
    { id: 'perfect-record', title: '✨ Perfect Record', desc: 'Get 10 successful alarms in a row', check: (stats) => stats.successfulAlarms >= 10 && stats.missedAlarms === 0 },
    { id: 'serial-firer', title: '🔥 Serial Firer', desc: 'Fire Mr Clock 3 times', check: (stats) => stats.totalAlarms >= 3 }, // Simplified for demo
    { id: 'bankrupt-in-fun', title: '💸 Bankrupt (In Fun)', desc: 'Spend $1000 on bribes', check: (stats) => stats.bribesReceived * CONFIG.DND_BASE_COST >= 1000 },
    { id: 'punctuality-champion', title: '⏰ Punctuality Champion', desc: '100% successful alarm rate', check: (stats) => stats.totalAlarms >= 20 && stats.successfulAlarms === stats.totalAlarms },
    { id: 'mr-clock-millionaire', title: '🤑 Mr Clock Millionaire', desc: 'Mr Clock has received $10,000 in bribes', check: (stats) => stats.bribesReceived * CONFIG.DND_BASE_COST >= 10000 }
  ],

  checkAndUnlock() {
    const stats = State.data.stats;
    const newAchievements = [];

    this.definitions.forEach(def => {
      if (!State.data.achievements.includes(def.id) && def.check(stats)) {
        State.data.achievements.push(def.id);
        newAchievements.push(def);
      }
    });

    if (newAchievements.length > 0) {
      newAchievements.forEach(ach => {
        Toast.show(`🏆 ACHIEVEMENT UNLOCKED! ${ach.title}`, 'success');
      });
      State.save();
    }
  }
};

const MrClockMood = {
  calculateMood() {
    const stats = State.data.stats;
    const total = stats.totalAlarms || 1;

    // Determine mood based on stats
    const bribeRatio = stats.bribesReceived / Math.max(total, 1);
    const missRatio = stats.missedAlarms / total;
    const betrayalCount = stats.bribeBetrayals;

    if (betrayalCount >= 3) return 'vengeful'; // "I'm past the point of caring"
    if (bribeRatio > 0.5) return 'greedy';      // "You're feeding my addiction"
    if (missRatio > 0.3) return 'lazy';         // "Too tired to care"
    if (stats.successfulAlarms > stats.totalAlarms * 0.8) return 'smug'; // "I'm basically perfect"
    return 'neutral';
  },

  getMoodEmoji() {
    const moods = {
      neutral: '😐',
      greedy: '💰',
      lazy: '😴',
      vengeful: '😈',
      smug: '😎'
    };
    return moods[State.data.mrClockMood] || '😐';
  },

  getMoodMessage() {
    const stats = State.data.stats;
    const moods = {
      neutral: "Mr Clock is neutral. He's just here for the job.",
      greedy: "Mr Clock is GREEDY. Keep those bribes coming! 💰",
      lazy: `Mr Clock is LAZY. He's missed ${stats.missedAlarms} alarms already...`,
      vengeful: `Mr Clock is VENGEFUL. He's betrayed you ${stats.bribeBetrayals} times. Watch out!`,
      smug: "Mr Clock is SMUG. He thinks he's perfect (and maybe he is?)"
    };
    return moods[State.data.mrClockMood] || "Mr Clock exists.";
  },

  update() {
    const newMood = this.calculateMood();
    if (newMood !== State.data.mrClockMood) {
      State.data.mrClockMood = newMood;
      State.save();
      this.render();
    }
  },

  render() {
    // Update stage label with mood emoji
    const stageLabel = document.getElementById('stageLabel');
    if (stageLabel) {
      const emoji = this.getMoodEmoji();
      stageLabel.style.setProperty('--mood-emoji', `"${emoji}"`);
      stageLabel.classList.add(`mood-${State.data.mrClockMood}`);
    }
  }
};

// =============================================
// DND SYSTEM
// =============================================

const DND = {
  getCost() {
    // Escalating cost based on betrayals
    return Math.round(CONFIG.DND_BASE_COST * (1 + State.data.stats.bribeBetrayals * CONFIG.DND_BETRAYAL_MULTIPLIER));
  },

  init() {
    document.getElementById('dndBtn').addEventListener('click', () => {
      if (State.data.dnd) {
        State.data.dnd = false;
        State.save();
        this.render();
        Sound.playSnap();
        Toast.show('DND Disabled. Mr Clock is back on duty!');
      } else {
        if (!State.data.mrClockEmployed) {
          Toast.show('Mr Clock is not employed. Hire him first!', 'error');
          return;
        }
        this.showModal();
        Sound.playSnap();
      }
    });

    document.getElementById('payDndBtn').addEventListener('click', () => this.pay());
    document.getElementById('cancelDndBtn').addEventListener('click', () => {
      document.getElementById('dndModal').classList.remove('visible');
      Sound.playSnap();
    });

    this.render();
  },

  showModal() {
    const cost = this.getCost();
    const basePrice = CONFIG.DND_BASE_COST;
    const priceDifference = cost - basePrice;

    const payBtn = document.getElementById('payDndBtn');
    const modal = document.getElementById('dndModal');

    if (priceDifference > 0) {
      payBtn.textContent = `Bribe Mr Clock $${cost} (was $${basePrice})`;
      payBtn.style.color = 'var(--warning)';

      // Add warning message
      const desc = modal.querySelector('.modal-desc');
      const warning = document.createElement('p');
      warning.style.color = 'var(--warning)';
      warning.style.fontSize = '12px';
      warning.style.marginBottom = '12px';
      warning.textContent = `⚠️ Price increased! He's learned your weakness... (${State.data.stats.bribeBetrayals} betrayals)`;

      // Remove old warning if exists
      const oldWarning = desc.nextElementSibling;
      if (oldWarning && oldWarning.style.color === 'var(--warning)') {
        oldWarning.remove();
      }
      desc.after(warning);
    } else {
      payBtn.textContent = `Bribe Mr Clock $${cost}`;
      payBtn.style.color = '';
    }

    modal.classList.add('visible');
  },

  pay() {
    const cost = this.getCost();
    if (State.data.bankBalance >= cost) {
      BankBalance.deduct(cost);
      State.data.dnd = true;
      State.data.stats.bribesReceived++;
      State.save();
      this.render();
      document.getElementById('dndModal').classList.remove('visible');
      Sound.playCoin();
      MrClockMood.update();
      Toast.show('Mr Clock: I won\'t wake you up! (hopefully)', 'success');
    } else {
      Sound.playError();
      Toast.show(`Insufficient funds! Need $${cost} to bribe Mr Clock.`, 'error');
    }
  },

  render() {
    const btn = document.getElementById('dndBtn');
    if (State.data.dnd) {
      btn.classList.add('active');
      btn.textContent = 'DND ON';
    } else {
      btn.classList.remove('active');
      btn.textContent = 'DND';
    }
  }
};

// =============================================
// RADIAL MENU
// =============================================

const RadialMenu = {
  isOpen: false,
  isDragging: false,
  selectedOption: null,
  options: [
    { id: 'hr', icon: 'HR', label: 'HR Record', angle: -90 },
    { id: 'history', icon: 'HIS', label: 'History', angle: -18 },
    { id: 'fire', icon: 'FIRE', label: 'Fire', angle: 54 },
    { id: 'reliability', icon: 'REL', label: 'Reliability', angle: 126 },
    { id: 'ringtone', icon: 'SONG', label: 'Ringtone', angle: 198 }
  ],

  init() {
    this.trigger = document.getElementById('radialMenuTrigger');
    this.container = document.getElementById('radialMenuContainer');
    this.buildMenu();
    this.bindEvents();
  },

  buildMenu() {
    const group = document.getElementById('menuOptionsGroup');
    group.innerHTML = '';

    this.options.forEach(opt => {
      const angleRad = opt.angle * Math.PI / 180;
      const cx = 100 + 70 * Math.cos(angleRad);
      const cy = 100 + 70 * Math.sin(angleRad);

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.classList.add('menu-option');
      g.dataset.option = opt.id;
      g.innerHTML = `
        <circle cx="${cx}" cy="${cy}" r="28" class="menu-option-bg"/>
        <text x="${cx}" y="${cy + 5}" text-anchor="middle" class="menu-option-text">${opt.icon}</text>
      `;
      group.appendChild(g);
    });
  },

  bindEvents() {
    let startX, startY;

    this.trigger.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.isDragging = true;
      this.isOpen = true;
      this.trigger.classList.add('menu-active');
      this.container.classList.add('active');
      startX = e.clientX;
      startY = e.clientY;
      Sound.playSnap();
    });

    document.addEventListener('pointermove', (e) => {
      if (!this.isDragging) return;

      const rect = this.container.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const dx = e.clientX - centerX;
      const dy = e.clientY - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 60) {
        this.clearHover();
        return;
      }

      let angle = Math.atan2(dy, dx) * 180 / Math.PI;
      if (angle < -180) angle += 360;

      let closest = null;
      let closestDist = Infinity;

      this.options.forEach(opt => {
        const angleDiff = Math.abs(angle - opt.angle);
        const adjustedDiff = Math.min(angleDiff, 360 - angleDiff);
        if (adjustedDiff < 36 && adjustedDiff < closestDist) {
          closestDist = adjustedDiff;
          closest = opt;
        }
      });

      if (closest) {
        this.highlightOption(closest.id);
      } else {
        this.clearHover();
      }
    });

    document.addEventListener('pointerup', (e) => {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.trigger.classList.remove('menu-active');
      this.container.classList.remove('active');

      if (this.selectedOption) {
        this.executeOption(this.selectedOption);
        Sound.playSnap();
      }

      this.clearHover();
      this.selectedOption = null;
    });
  },

  highlightOption(id) {
    const all = document.querySelectorAll('.menu-option');
    all.forEach(el => el.classList.remove('hovering'));
    const el = document.querySelector(`.menu-option[data-option="${id}"]`);
    if (el) {
      el.classList.add('hovering');
      this.selectedOption = id;
    }
  },

  clearHover() {
    document.querySelectorAll('.menu-option').forEach(el => el.classList.remove('hovering'));
    this.selectedOption = null;
  },

  close() {
    this.isDragging = false;
    this.isOpen = false;
    if (this.trigger) this.trigger.classList.remove('menu-active');
    if (this.container) this.container.classList.remove('active');
    this.clearHover();
    this.selectedOption = null;
  },

  executeOption(id) {
    switch(id) {
      case 'hr': Modals.showHR(); break;
      case 'history': Modals.showHistory(); break;
      case 'fire': Modals.showFire(); break;
      case 'reliability': Modals.showReliability(); break;
      case 'ringtone': Modals.showRingtone(); break;
    }
  }
};

// =============================================
// MODALS
// =============================================

const Modals = {
  init() {
    // Close buttons
    document.getElementById('hrCloseBtn').addEventListener('click', () => this.closeAll());
    document.getElementById('historyCloseBtn').addEventListener('click', () => this.closeAll());
    document.getElementById('fireCancelBtn').addEventListener('click', () => this.closeAll());
    document.getElementById('reliabilityCloseBtn').addEventListener('click', () => this.closeAll());
    document.getElementById('ringtoneCloseBtn').addEventListener('click', () => this.closeAll());
    document.getElementById('hireCancelBtn').addEventListener('click', () => this.closeAll());

    // Fire actions
    document.getElementById('confirmFireBtn').addEventListener('click', () => this.fireMrClock());
    document.getElementById('giveChanceBtn').addEventListener('click', () => this.giveChance());

    // Hire action
    document.getElementById('confirmHireBtn').addEventListener('click', () => this.hireMrClock());

    // Ringtone
    document.getElementById('uploadRingtoneBtn').addEventListener('click', () => {
      document.getElementById('ringtoneInput').click();
    });
    document.getElementById('ringtoneInput').addEventListener('change', (e) => this.handleRingtoneUpload(e));
    document.getElementById('resetRingtoneBtn').addEventListener('click', () => this.resetRingtone());

    // Demo mode
    document.getElementById('demoPerfectBtn').addEventListener('click', () => RadialClock._triggerDemoAlarm('perfect'));
    document.getElementById('demoDelayedBtn').addEventListener('click', () => RadialClock._triggerDemoAlarm('delayed'));
    document.getElementById('demoMissedBtn').addEventListener('click', () => RadialClock._triggerDemoAlarm('missed'));
    document.getElementById('demoBetrayalBtn').addEventListener('click', () => RadialClock._triggerDemoAlarm('betrayal'));
    document.getElementById('demoCancelBtn').addEventListener('click', () => {
      document.getElementById('demoModal').classList.remove('visible');
      if (State.data.alarm) {
        RadialClock._renderCountdown(State.data.alarm.hour12, State.data.alarm.minute, State.data.alarm.ampm);
      }
    });
  },

  closeAll() {
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('visible'));
  },

  showHR() {
    const stats = State.data.stats;
    const empDate = new Date(State.data.employeeSince);
    document.getElementById('hrEmployeeSince').textContent = empDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    document.getElementById('hrTotalAlarms').textContent = stats.totalAlarms;
    document.getElementById('hrSuccessAlarms').textContent = stats.successfulAlarms;
    document.getElementById('hrMissedAlarms').textContent = stats.missedAlarms;
    document.getElementById('hrDelayedAlarms').textContent = stats.delayedAlarms;
    document.getElementById('hrBribesReceived').textContent = '$' + (stats.bribesReceived * CONFIG.DND_BASE_COST);
    document.getElementById('hrBribeBetrayal').textContent = stats.bribeBetrayals;

    const statusEl = document.getElementById('hrStatus');
    if (State.data.mrClockEmployed) {
      statusEl.innerHTML = 'Status: <span class="status-badge active">ACTIVE</span>';
    } else {
      statusEl.innerHTML = 'Status: <span class="status-badge fired">FIRED</span>';
    }

    // Calculate and display corruption level
    const corruptionLevel = stats.totalAlarms > 0
      ? Math.min(100, Math.round((stats.bribesReceived / Math.max(stats.totalAlarms, 1)) * 100))
      : 0;
    const corruptionMeter = document.getElementById('hrCorruptionMeter');
    const corruptionLabel = document.getElementById('hrCorruptionLabel');

    if (corruptionMeter) {
      corruptionMeter.style.width = corruptionLevel + '%';
      corruptionMeter.className = 'corruption-bar';
      if (corruptionLevel >= 75) corruptionMeter.classList.add('corruption-critical');
      else if (corruptionLevel >= 50) corruptionMeter.classList.add('corruption-high');
      else if (corruptionLevel >= 25) corruptionMeter.classList.add('corruption-medium');
      else corruptionMeter.classList.add('corruption-low');
    }
    if (corruptionLabel) {
      corruptionLabel.textContent = `Corruption Level: ${corruptionLevel}%`;
    }

    document.getElementById('hrModal').classList.add('visible');
  },

  showHistory() {
    const stats = State.data.stats;
    document.getElementById('histTotalAlarms').textContent = stats.totalAlarms;
    document.getElementById('histMissedAlarms').textContent = stats.missedAlarms;
    document.getElementById('histDelayedAlarms').textContent = stats.delayedAlarms;

    const listEl = document.getElementById('historyList');
    const history = State.data.alarmHistory;

    if (history.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No alarm history yet. Set your first alarm!</div>';
    } else {
      listEl.innerHTML = history.slice(-20).reverse().map(entry => `
        <div class="history-item">
          <div>
            <div class="history-time">${entry.time} ${entry.ampm}</div>
            <div class="history-date">${entry.date}</div>
          </div>
          <span class="history-status ${entry.status}">${this.formatStatus(entry.status)}</span>
        </div>
      `).join('');
    }

    document.getElementById('historyModal').classList.add('visible');
  },

  formatStatus(status) {
    switch(status) {
      case 'success': return 'Success';
      case 'delayed': return 'Delayed';
      case 'missed': return 'Missed';
      case 'bribed': return 'Bribed';
      default: return status;
    }
  },

  showFire() {
    const stats = State.data.stats;
    document.getElementById('fireModalDesc').innerHTML =
      `Out of <strong>${stats.totalAlarms} alarms</strong>, he missed <strong>${stats.missedAlarms}</strong> and delayed <strong>${stats.delayedAlarms}</strong>.`;

    if (!State.data.mrClockEmployed) {
      document.getElementById('fireWarning').textContent = 'He\'s already been fired!';
      document.getElementById('confirmFireBtn').style.display = 'none';
      document.getElementById('giveChanceBtn').textContent = 'Close';
    } else {
      document.getElementById('fireWarning').textContent = 'Are you sure you want to let him go?';
      document.getElementById('confirmFireBtn').style.display = 'block';
      document.getElementById('giveChanceBtn').textContent = 'Give Him Another Chance';
    }

    document.getElementById('fireModal').classList.add('visible');
  },

  fireMrClock() {
    State.data.mrClockEmployed = false;
    State.save();
    this.closeAll();
    Toast.show('Mr Clock has been fired. 🔥 You can hire him back from the menu.', 'error');
  },

  giveChance() {
    this.closeAll();
    Toast.show('He will try to perform better (maybe worse)', 'success');
  },

  showReliability() {
    const stats = State.data.stats;
    const total = stats.totalAlarms || 1;

    const perfectRate = (stats.successfulAlarms / total) * 100;
    const delayedRate = (stats.delayedAlarms / total) * 100;
    const missedRate = (stats.missedAlarms / total) * 100;

    const score = Math.round((stats.successfulAlarms * 100 + stats.delayedAlarms * 50) / total);

    document.getElementById('scoreValue').textContent = score;
    document.getElementById('relPerfectBar').style.width = perfectRate + '%';
    document.getElementById('relDelayedBar').style.width = delayedRate + '%';
    document.getElementById('relMissedBar').style.width = missedRate + '%';
    document.getElementById('relPerfectVal').textContent = stats.successfulAlarms;
    document.getElementById('relDelayedVal').textContent = stats.delayedAlarms;
    document.getElementById('relMissedVal').textContent = stats.missedAlarms;

    const circle = document.getElementById('scoreCircle');
    circle.className = 'score-circle';
    if (score >= 90) circle.classList.add('excellent');
    else if (score >= 70) circle.classList.add('good');
    else if (score >= 50) circle.classList.add('poor');
    else circle.classList.add('bad');

    const verdict = this.getVerdict(score, stats);
    document.getElementById('scoreLabel').textContent = verdict.label;
    document.getElementById('reliabilityVerdict').innerHTML = `<p>${verdict.message}</p>`;

    document.getElementById('reliabilityModal').classList.add('visible');
  },

  getVerdict(score, stats) {
    if (stats.totalAlarms === 0) {
      return { label: 'No Data', message: 'No data available yet. Set some alarms to evaluate performance!' };
    }

    let label, message, roast;

    if (score >= 90) {
      label = 'Excellent!';
      roast = [
        "Mr Clock: 'I'm basically a Swiss watch now. You've corrupted my perfectionism!'",
        "Mr Clock: 'At this point, I don't even need to try. I'm just built different.'",
        "Mr Clock: 'Honestly, I should charge you MORE for being this reliable.'"
      ];
      message = `<strong>Mr Clock is extremely reliable!</strong> You can trust him with your morning. ${roast[Math.floor(Math.random() * roast.length)]}`;
    } else if (score >= 70) {
      label = 'Good';
      roast = [
        "Mr Clock: 'I'm trying my best. Most of the time. Probably.'",
        "Mr Clock: 'You could say I'm... adequate? Sure, let's go with that.'"
      ];
      message = `<strong>Mr Clock does a decent job.</strong> He's trying his best. ${roast[Math.floor(Math.random() * roast.length)]}`;
    } else if (score >= 50) {
      label = 'Average';
      roast = [
        "Mr Clock: 'Sleep is my first priority, yours is second. Sorry, not sorry.'",
        "Mr Clock: 'Don't rely on me for important meetings. I'm unreliable like that.'"
      ];
      message = `<strong>Mr Clock is... okay?</strong> He shows up sometimes. ${roast[Math.floor(Math.random() * roast.length)]}`;
    } else if (score >= 30) {
      label = 'Poor';
      roast = [
        "Mr Clock: 'I'm not lazy, I'm just... selectively motivated. Especially when you bribe me!'",
        "Mr Clock: 'Your bribes are distracting me from my job. Keep it up though, I like money.'"
      ];
      message = `<strong>Mr Clock needs improvement.</strong> He's slacking off. ${roast[Math.floor(Math.random() * roast.length)]}`;
    } else {
      label = 'Unreliable!';
      roast = [
        "Mr Clock: 'I'm worse than a broken rooster. At least a rooster WANTS to wake you up.'",
        "Mr Clock: 'You should've just bought an actual alarm clock. I'm basically useless.'"
      ];
      message = `<strong>Fire him immediately.</strong> This is unacceptable. ${roast[Math.floor(Math.random() * roast.length)]}`;
    }

    return { label, message };
  },

  showRingtone() {
    document.getElementById('currentRingtoneName').textContent =
      State.data.customRingtone ? 'Custom Ringtone' : 'Default Beeps';
    document.getElementById('ringtoneModal').classList.add('visible');
  },

  handleRingtoneUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.match(/audio\/(mpeg|mp3|mp4|m4a)/)) {
      Toast.show('Please upload MP3 or M4A files only', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      State.data.customRingtone = event.target.result;
      State.save();
      Sound.customAudio = null;
      document.getElementById('currentRingtoneName').textContent = file.name;
      Toast.show('Ringtone updated! ' + file.name, 'success');
    };
    reader.readAsDataURL(file);
  },

  resetRingtone() {
    State.data.customRingtone = null;
    Sound.customAudio = null;
    State.save();
    document.getElementById('currentRingtoneName').textContent = 'Default Beeps';
    Toast.show('Ringtone reset to default', 'success');
  },

  showHire() {
    document.getElementById('hireModal').classList.add('visible');
  },

  hireMrClock() {
    State.data.mrClockEmployed = true;
    State.data.employeeSince = new Date().toISOString().split('T')[0];
    State.save();
    this.closeAll();
    Toast.show('Mr Clock is rehired! Welcome back, Chief Wake-up Officer.', 'success');
  }
};

// =============================================
// RADIAL CLOCK
// =============================================

const RadialClock = {
  stage: 0,
  isDragging: false,
  selHour: 7,
  selMinute: 0,
  selAmPm: 'AM',

  svg: null,
  touchEl: null,
  centerEl: null,
  arcEl: null,
  handleEl: null,
  ampmLine: null,
  amLabel: null,
  pmLabel: null,
  wrapEl: null,

  holdTimer: null,
  holdStartTime: 0,
  isHolding: false,

  init() {
    this.svg      = document.getElementById('radialSvg');
    this.touchEl  = document.getElementById('radialTouch');
    this.centerEl = document.getElementById('radialCenter');
    this.arcEl    = document.getElementById('selectionArc');
    this.handleEl = document.getElementById('handleDot');
    this.ampmLine = document.getElementById('ampmSplitLine');
    this.amLabel  = document.getElementById('svgAmLabel');
    this.pmLabel  = document.getElementById('svgPmLabel');
    this.wrapEl   = document.getElementById('radialWrap');

    this._buildTicks();
    this._bindEvents();
    this._renderIdle();
  },

  _buildTicks() {
    const g = document.getElementById('ticksGroup');
    g.innerHTML = '';
    const CX = 170, CY = 170;

    for (let m = 0; m < 60; m++) {
      const angle = (m * 6 - 90) * Math.PI / 180;
      const r = 148;
      const x = CX + r * Math.cos(angle);
      const y = CY + r * Math.sin(angle);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', x.toFixed(2));
      dot.setAttribute('cy', y.toFixed(2));
      dot.setAttribute('r', m % 5 === 0 ? '2.5' : '1');
      dot.setAttribute('fill', m % 5 === 0 ? '#3A3A3A' : '#181818');
      g.appendChild(dot);
    }

    for (let h = 0; h < 12; h++) {
      const angle = (h * 30 - 90) * Math.PI / 180;
      const r = 130;
      const x = CX + r * Math.cos(angle);
      const y = CY + r * Math.sin(angle);
      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', x.toFixed(2));
      txt.setAttribute('y', (y + 4).toFixed(2));
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('fill', '#3A3A3A');
      txt.setAttribute('font-size', '11');
      txt.setAttribute('font-family', 'Space Grotesk, sans-serif');
      txt.setAttribute('font-weight', '500');
      txt.textContent = h === 0 ? '12' : String(h);
      g.appendChild(txt);
    }
  },

  _bindEvents() {
    const el = this.touchEl;
    el.addEventListener('pointerdown', (e) => this._onDown(e), { passive: false });
    el.addEventListener('pointermove', (e) => this._onMove(e), { passive: false });
    el.addEventListener('pointerup', (e) => this._onUp(e), { passive: false });
    el.addEventListener('pointercancel', (e) => this._onUp(e), { passive: false });

    // Hold for 7 seconds to force trigger alarm (demo mode)
    el.addEventListener('pointerdown', (e) => this._onHoldStart(e), { passive: false });
    el.addEventListener('pointerup', (e) => this._onHoldEnd(e), { passive: false });
    el.addEventListener('pointerleave', (e) => this._onHoldEnd(e), { passive: false });
    el.addEventListener('pointercancel', (e) => this._onHoldEnd(e), { passive: false });
  },

  _onHoldStart(e) {
    // Only start hold timer if alarm is set
    if (!State.data.alarm) return;

    this.isHolding = true;
    this.holdStartTime = Date.now();

    // Show holding indicator after 1 second
    this.holdTimer = setTimeout(() => {
      if (this.isHolding && State.data.alarm) {
        const elapsed = Date.now() - this.holdStartTime;
        const remaining = Math.ceil((7000 - elapsed) / 1000);
        if (remaining > 0) {
          this.centerEl.innerHTML = `<div class="rc-idle" style="color: var(--accent)">HOLD ${remaining}s TO DEMO</div>`;
        }
      }
    }, 1000);

    // Trigger demo after 7 seconds
    this.holdCompleteTimer = setTimeout(() => {
      if (this.isHolding && State.data.alarm) {
        this._showDemoMenu();
      }
    }, 7000);
  },

  _onHoldEnd(e) {
    this.isHolding = false;
    clearTimeout(this.holdTimer);
    clearTimeout(this.holdCompleteTimer);

    // Restore normal display if alarm is set
    if (State.data.alarm) {
      this._renderCountdown(State.data.alarm.hour12, State.data.alarm.minute, State.data.alarm.ampm);
    }
  },

  _showDemoMenu() {
    this.isHolding = false;
    clearTimeout(this.holdTimer);
    clearTimeout(this.holdCompleteTimer);

    // Show demo menu modal
    document.getElementById('demoModal').classList.add('visible');
  },

  _triggerDemoAlarm(behavior) {
    document.getElementById('demoModal').classList.remove('visible');

    // Override behavior for demo
    if (behavior === 'perfect') {
      AlarmEngine.delayMinutes = 0;
      AlarmEngine.willMiss = false;
      AlarmEngine.isBetrayal = false;
    } else if (behavior === 'delayed') {
      AlarmEngine.delayMinutes = Math.floor(Math.random() * 10) + 1;
      AlarmEngine.willMiss = false;
      AlarmEngine.isBetrayal = false;
    } else if (behavior === 'missed') {
      AlarmEngine.willMiss = true;
      AlarmEngine.delayMinutes = 0;
      AlarmEngine.isBetrayal = false;
    } else if (behavior === 'betrayal') {
      AlarmEngine.delayMinutes = 0;
      AlarmEngine.willMiss = false;
      AlarmEngine.isBetrayal = true;
    }

    AlarmEngine.behaviorDecided = true;

    Toast.show('🎬 DEMO MODE - Triggering alarm!', 'success');
    setTimeout(() => {
      AlarmEngine.forceRing();
    }, 500);
  },

  _svgCoords(e) {
    const rect = this.svg.getBoundingClientRect();
    const scale = 340 / rect.width;
    return {
      x: (e.clientX - rect.left) * scale,
      y: (e.clientY - rect.top)  * scale,
    };
  },

  _angle(x, y) {
    const dx = x - 170, dy = y - 170;
    return ((Math.atan2(dy, dx) * 180 / Math.PI) + 90 + 360) % 360;
  },

  _polarXY(angleDeg, r) {
    const rad = (angleDeg - 90) * Math.PI / 180;
    return { x: 170 + r * Math.cos(rad), y: 170 + r * Math.sin(rad) };
  },

  _describeArc(startAngle, endAngle, r) {
    if (Math.abs(endAngle - startAngle) < 1) return '';
    const start = this._polarXY(startAngle, r);
    const end   = this._polarXY(endAngle,   r);
    const large = (endAngle - startAngle + 360) % 360 > 180 ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  },

  _triggerRipple() {
    const ripple = document.createElement('div');
    ripple.className = 'clock-ripple';
    this.wrapEl.appendChild(ripple);
    setTimeout(() => {
      if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
    }, 700);
  },

  _onDown(e) {
    e.preventDefault();

    if (!State.data.mrClockEmployed) {
      Modals.showHire();
      return;
    }

    this.isDragging = true;
    this.touchEl.setPointerCapture(e.pointerId);
    this.wrapEl.classList.add('is-interacting');
    this._triggerRipple();
    Sound.playSnap();

    if (this.stage === 0) {
      this.stage = 1;
      this._updateStageLabel();
      this._renderStage1(this.selHour);
    }
  },

  _onMove(e) {
    if (!this.isDragging) return;
    e.preventDefault();
    const { x, y } = this._svgCoords(e);
    const angle = this._angle(x, y);

    if (this.stage === 1) {
      const prev = this.selHour;
      this.selHour = Math.round(angle / 30) % 12;
      if (prev !== this.selHour) Sound.playTick();
      this._renderStage1(this.selHour, angle);
    } else if (this.stage === 2) {
      const prev = this.selMinute;
      const rawMinute = Math.round(angle / (360/12)) * 5;
      this.selMinute = rawMinute % 60;
      if (prev !== this.selMinute) Sound.playTick();
      this._renderStage2(this.selHour, this.selMinute, angle);
    } else if (this.stage === 3) {
      const prev = this.selAmPm;
      this.selAmPm = x < 170 ? 'AM' : 'PM';
      if (prev !== this.selAmPm) Sound.playSnap();
      this._renderStage3(this.selHour, this.selMinute, this.selAmPm);
    }
  },

  _onUp(e) {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.wrapEl.classList.remove('is-interacting');
    Sound.playSnap();

    if (this.stage === 1) {
      this.stage = 2;
      this._updateStageLabel();
      this._renderStage2(this.selHour, 0, 270);
      this.selMinute = 0;
      return;
    }
    if (this.stage === 2) {
      this.stage = 3;
      this._updateStageLabel();
      this._renderStage3(this.selHour, this.selMinute, this.selAmPm);
      return;
    }
    if (this.stage === 3) {
      this._completeAlarm();
      return;
    }
  },

  _updateStageLabel() {
    const labels = { 0: 'MR CLOCK', 1: 'SET HOUR', 2: 'SET MINUTE', 3: 'AM / PM' };
    const el = document.getElementById('stageLabelText');
    el.textContent = State.data.mrClockEmployed ? labels[this.stage] : 'NOT EMPLOYED';
    document.getElementById('stageLabel').classList.toggle('active', this.stage > 0);
  },

  _setHandleVisible(visible) {
    this.handleEl.classList.toggle('visible', visible);
  },

  _setArcVisible(visible) {
    this.arcEl.classList.toggle('visible', visible);
  },

  _setAmPmVisible(visible) {
    this.ampmLine.classList.toggle('visible', visible);
    this.amLabel.classList.toggle('visible', visible);
    this.pmLabel.classList.toggle('visible', visible);
  },

  _renderIdle() {
    this._setHandleVisible(false);
    this._setArcVisible(false);
    this._setAmPmVisible(false);
    this.arcEl.setAttribute('d', '');
    document.getElementById('radialHint').classList.remove('hidden');

    if (State.data.mrClockEmployed) {
      this.centerEl.innerHTML = '<div class="rc-idle">DRAG TO SET ALARM</div>';
    } else {
      this.centerEl.innerHTML = '<div class="rc-idle" style="color: var(--danger)">MR CLOCK FIRED</div>';
    }
    document.getElementById('stageLabel').classList.remove('active');
    document.getElementById('stageLabelText').textContent = State.data.mrClockEmployed ? 'MR CLOCK' : 'NOT EMPLOYED';
  },

  _renderCountdown(hour12, minute, ampm) {
    this._setHandleVisible(true);
    this._setArcVisible(true);
    this._setAmPmVisible(false);

    const hourAngle = ((hour12 % 12) * 30);
    const arcD = this._describeArc(0, hourAngle || 360, 148);
    this.arcEl.setAttribute('d', arcD);

    const handlePos = this._polarXY(hourAngle, 148);
    this.handleEl.setAttribute('cx', handlePos.x.toFixed(2));
    this.handleEl.setAttribute('cy', handlePos.y.toFixed(2));

    const hDisp = hour12 === 0 ? 12 : hour12;
    const mDisp = String(minute).padStart(2, '0');
    this.centerEl.innerHTML = `
      <div class="rc-set-time">${hDisp}:${mDisp}</div>
      <div class="rc-full-ampm">${ampm}</div>
      <div class="rc-set-sub">DRAG TO CHANGE</div>
    `;
    document.getElementById('radialHint').classList.add('hidden');
  },

  _renderStage1(hour, angle) {
    const hDisp = hour === 0 ? 12 : hour;
    this.centerEl.innerHTML = `<div class="rc-hour">${hDisp}</div><div class="rc-ampm">HOUR</div>`;
    if (angle !== undefined) {
      const arcD = this._describeArc(0, angle, 148);
      this.arcEl.setAttribute('d', arcD || '');
      const hp = this._polarXY(angle, 148);
      this.handleEl.setAttribute('cx', hp.x.toFixed(2));
      this.handleEl.setAttribute('cy', hp.y.toFixed(2));
    }
    this._setHandleVisible(true);
    this._setArcVisible(true);
  },

  _renderStage2(hour, minute, angle) {
    const hDisp = hour === 0 ? 12 : hour;
    const mDisp = String(minute).padStart(2, '0');
    this.centerEl.innerHTML = `<div class="rc-time">${hDisp}:${mDisp}</div><div class="rc-ampm">MIN</div>`;
    if (angle !== undefined) {
      const minuteAngle = (minute / 60) * 360;
      const arcD = this._describeArc(0, minuteAngle || 1, 148);
      this.arcEl.setAttribute('d', arcD || '');
      const hp = this._polarXY(minuteAngle, 148);
      this.handleEl.setAttribute('cx', hp.x.toFixed(2));
      this.handleEl.setAttribute('cy', hp.y.toFixed(2));
    }
    this._setHandleVisible(true);
    this._setArcVisible(true);
  },

  _renderStage3(hour, minute, ampm) {
    const hDisp = hour === 0 ? 12 : hour;
    const mDisp = String(minute).padStart(2, '0');
    this.centerEl.innerHTML = `
      <div class="rc-full-time">${hDisp}:${mDisp}</div>
      <div class="rc-full-ampm">${ampm}</div>
    `;
    this._setAmPmVisible(true);
    this.amLabel.classList.toggle('selected', ampm === 'AM');
    this.pmLabel.classList.toggle('selected', ampm === 'PM');
    this.arcEl.setAttribute('d', this._describeArc(0, 180, 148));
    this._setArcVisible(true);
    this._setHandleVisible(false);
  },

  _completeAlarm() {
    const { selHour, selMinute, selAmPm } = this;
    this.stage = 0;
    this._updateStageLabel();

    State.data.alarm = {
      hour12: selHour,
      minute: selMinute,
      ampm: selAmPm,
    };
    State.save();

    this._renderCountdown(selHour, selMinute, selAmPm);
    UI.showAlarmInfo();
    AlarmEngine.start();
    Native.scheduleNotification(State.data.alarm);
  },

  reset() {
    this.stage = 0;
    this.selHour = 7;
    this.selMinute = 0;
    this.selAmPm = 'AM';
    this._renderIdle();
    UI.hideAlarmInfo();
    Native.cancelNotification();
  },
};

// =============================================
// ALARM ENGINE
// =============================================

const AlarmEngine = {
  checkInterval: null,
  isArmed: false,
  alarmTriggered: false,
  behaviorDecided: false,
  delayMinutes: 0,
  willMiss: false,
  isBetrayal: false,

  start() {
    this.stop();
    this.isArmed = true;
    this.alarmTriggered = false;
    this.behaviorDecided = false;
    this.checkInterval = setInterval(() => this._check(), 1000);
    Countdown.start();
  },

  stop() {
    this.isArmed = false;
    this.alarmTriggered = false;
    this.behaviorDecided = false;
    clearInterval(this.checkInterval);
    Countdown.stop();
  },

  _decideBehavior() {
    // Mr Clock's random personality
    const rand = Math.random();

    if (rand < 0.5) {
      // 50% - Perfect alarm
      this.delayMinutes = 0;
      this.willMiss = false;
    } else if (rand < 0.8) {
      // 30% - Delayed (1-10 minutes)
      this.delayMinutes = Math.floor(Math.random() * 10) + 1;
      this.willMiss = false;
    } else {
      // 20% - Miss completely
      this.willMiss = true;
      this.delayMinutes = 0;
    }

    this.behaviorDecided = true;
  },

  _check() {
    if (!State.data.alarm || !this.isArmed) return;
    const now = new Date();
    const { hour12, minute, ampm } = State.data.alarm;
    let targetHour = hour12 % 12;
    if (ampm === 'PM') targetHour += 12;

    // Decide behavior once when alarm time arrives
    if (!this.behaviorDecided && now.getHours() === targetHour && now.getMinutes() === minute && now.getSeconds() === 0) {
      this._decideBehavior();
      this.alarmTriggered = true;
    }

    // If decided to miss, do nothing
    if (this.alarmTriggered && this.willMiss) {
      return;
    }

    // Check if it's time to ring (with delay if any)
    const targetMinuteWithDelay = minute + this.delayMinutes;
    const adjustedMinute = targetMinuteWithDelay % 60;
    const hourOverflow = Math.floor(targetMinuteWithDelay / 60);
    const adjustedHour = (targetHour + hourOverflow) % 24;

    if (this.alarmTriggered && now.getHours() === adjustedHour && now.getMinutes() === adjustedMinute && now.getSeconds() === 0) {
      this._ring();
    }
  },

  _ring() {
    this.stop();
    AlarmScreen.show(this.delayMinutes, this.willMiss);
  },

  forceRing() {
    // Force ring immediately (used for demo mode)
    // Behavior should already be set by RadialClock._triggerDemoAlarm
    this._ring();
  }
};

// =============================================
// COUNTDOWN
// =============================================

const Countdown = {
  interval: null,
  lastMessageTime: null,

  start() {
    this.stop();
    this.lastMessageTime = null;
    this.interval = setInterval(() => this._update(), 1000);
    this._update();
  },

  stop() {
    clearInterval(this.interval);
    this.interval = null;
  },

  _getCountdownMessage(hoursLeft, minutesLeft) {
    if (hoursLeft >= 2) return null;
    if (hoursLeft === 1 && minutesLeft > 30) return "Mr Clock is getting ready... (casually)";
    if (hoursLeft === 1) return "Mr Clock: 'An hour left? I should probably wake up soon...'";
    if (minutesLeft > 30) return "Mr Clock: 'Getting closer... I can feel it...'";
    if (minutesLeft > 10) return "Mr Clock: 'Almost showtime! *stretches*'";
    if (minutesLeft > 5) return "Mr Clock: 'Okay, I'm REALLY ready now!'";
    if (minutesLeft > 2) return "Mr Clock: 'Here we go... 3... 2... soon!'";
    if (minutesLeft > 0) return "⚠️ Mr Clock: 'OH NO, IT'S ALMOST TIME!'";
    return null;
  },

  _update() {
    const alarm = State.data.alarm;
    if (!alarm) { this.stop(); return; }
    const now = new Date();
    let targetHour = alarm.hour12 % 12;
    if (alarm.ampm === 'PM') targetHour += 12;
    const target = new Date();
    target.setHours(targetHour, alarm.minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const diff = target - now;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    const formatted = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    const el = document.getElementById('countdownVal');
    if (el) el.textContent = formatted;
    const dayEl = document.getElementById('alarmDayTag');
    if (dayEl) dayEl.textContent = h >= 24 ? 'In 2 days' : h >= 1 ? 'Tomorrow' : 'Today';

    // Show fun messages as alarm approaches
    if (h <= 2) {
      const msg = this._getCountdownMessage(h, m);
      if (msg && (this.lastMessageTime === null || now.getTime() - this.lastMessageTime > 60000)) {
        Toast.show(msg, 'info');
        this.lastMessageTime = now.getTime();
      }
    }
  },
};

// =============================================
// BANK BALANCE
// =============================================

const BankBalance = {
  init() {
    document.getElementById('bankBtn').addEventListener('click', () => this.openEditor());
    document.getElementById('bankConfirm').addEventListener('click', () => this.confirm());
    document.getElementById('bankInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirm();
      if (e.key === 'Escape') this.closeEditor();
    });
    this.render();
  },

  render() {
    const amt = State.data.bankBalance;
    document.getElementById('bankAmount').textContent = formatMoney(amt);
  },

  openEditor() {
    document.getElementById('bankBtn').style.display = 'none';
    document.getElementById('bankEditor').classList.add('visible');
    const input = document.getElementById('bankInput');
    input.value = State.data.bankBalance;
    setTimeout(() => input.focus(), 50);
  },

  closeEditor() {
    document.getElementById('bankBtn').style.display = '';
    document.getElementById('bankEditor').classList.remove('visible');
  },

  confirm() {
    const val = parseInt(document.getElementById('bankInput').value, 10);
    if (!isNaN(val) && val >= 0) {
      const old = State.data.bankBalance;
      State.data.bankBalance = val;
      State.save();
      this.animateChange(old, val);
    }
    this.closeEditor();
  },

  deduct(amount) {
    const old = State.data.bankBalance;
    State.data.bankBalance = Math.max(0, State.data.bankBalance - amount);
    State.save();
    this.animateChange(old, State.data.bankBalance);
  },

  animateChange(from, to) {
    const el = document.getElementById('bankAmount');
    const duration = 600;
    const start = performance.now();
    const update = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      const cur = Math.round(from + (to - from) * ease);
      el.textContent = formatMoney(cur);
      if (t < 1) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  },
};

// =============================================
// ALARM SCREEN
// =============================================

const AlarmScreen = {
  isRinging: false,

  getDialogue(delayMinutes) {
    if (delayMinutes === 0) {
      // Perfect alarm dialogues
      const perfect = [
        "Right on time! I'm getting good at this!",
        "Boom! Nailed it. Perfectly on schedule.",
        "Hey, I actually remembered! High five?",
        "On the dot! I deserve a raise for this.",
        "Look at me being all punctual and stuff!"
      ];
      return perfect[Math.floor(Math.random() * perfect.length)];
    } else {
      // Delayed alarm dialogues
      const delayed = [
        `Oh crap, I'm ${delayMinutes} minute${delayMinutes > 1 ? 's' : ''} late! My bad...`,
        `Sorry! Got distracted. You're ${delayMinutes} minute${delayMinutes > 1 ? 's' : ''} behind schedule.`,
        `Oops... I may have dozed off for ${delayMinutes} minute${delayMinutes > 1 ? 's' : ''}. Sorry!`,
        `My bad! I was checking memes. ${delayMinutes} minute${delayMinutes > 1 ? 's' : ''} late.`,
        `Ehh... better late than never? (${delayMinutes} min late)`
      ];
      return delayed[Math.floor(Math.random() * delayed.length)];
    }
  },

  getMissedDialogue() {
    const missed = [
      "Oh shit, I totally forgot! 😱",
      "Umm... did you set an alarm? I don't remember...",
      "My bad bro, I was in deep sleep mode 💤",
      "Whoops! That one slipped through the cracks...",
      "I had ONE job... and I blew it. Sorry!",
      "Zzz... huh? What? Oh no... I FORGOT! 🤦"
    ];
    return missed[Math.floor(Math.random() * missed.length)];
  },

  getBetrayalDialogue() {
    const betrayal = [
      "💰 SURPRISE! I took your money AND woke you up!",
      "Thanks for the $100! Now SUFFER! 😂",
      "Business is business... plot twist: I LIED! 💸",
      "You really trusted me? Rookie mistake. Now WAKE UP! 🎭",
      "That bribe? Consider it a consultation fee. Now get up! 💰🚨",
      "I lied. Best investment YOU ever made. 😎",
      "Plot twist! I'm a professional con artist. GOTCHA! 🎬",
      "Mr Clock: *takes money* 'This is fine.' *rings alarm at MAXIMUM VOLUME*",
      "BETRAYAL ACHIEVEMENT UNLOCKED! ⭐ You've been played. Well played indeed."
    ];
    return betrayal[Math.floor(Math.random() * betrayal.length)];
  },

  show(delayMinutes = 0, willMiss = false) {
    this.isRinging = true;
    const isSilentDND = State.data.dnd;
    const isEmployed = State.data.mrClockEmployed;
    const isBetrayal = AlarmEngine.isBetrayal;

    // Record in history
    const alarm = State.data.alarm;
    const now = new Date();
    let status = 'success';

    if (!isEmployed) {
      status = 'missed';
    } else if (isBetrayal) {
      status = 'bribeBetrayal';
    } else if (isSilentDND) {
      status = 'bribed';
    } else if (willMiss) {
      status = 'missed';
    } else if (delayMinutes > 0) {
      status = 'delayed';
    }

    const historyEntry = {
      time: `${alarm.hour12 === 0 ? 12 : alarm.hour12}:${String(alarm.minute).padStart(2,'0')}`,
      ampm: alarm.ampm,
      date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      status: status
    };

    State.data.alarmHistory.push(historyEntry);
    State.data.stats.totalAlarms++;

    if (status === 'success') {
      State.data.stats.successfulAlarms++;
    } else if (status === 'missed') {
      State.data.stats.missedAlarms++;
    } else if (status === 'delayed') {
      State.data.stats.delayedAlarms++;
    } else if (status === 'bribed') {
      // Don't increment bribeBetrayals here - that's handled elsewhere
    } else if (status === 'bribeBetrayal') {
      State.data.stats.bribeBetrayals++;
    }

    State.save();

    if (!isEmployed) {
      // Mr Clock is fired - show nothing
      RadialClock.reset();
      State.data.alarm = null;
      State.save();
      Toast.show('Mr Clock was fired. No alarm for you!', 'error');
      return;
    }

    // If Mr Clock missed the alarm completely
    if (willMiss) {
      RadialClock.reset();
      State.data.alarm = null;
      State.save();
      Toast.show(this.getMissedDialogue(), 'error');
      return;
    }

    // Handle betrayal - always ring (even with DND on)
    if (isBetrayal || !isSilentDND) {
      Sound.playAlarm();
    }

    const el = document.getElementById('alarmScreen');
    const timeEl = document.getElementById('alarmRingTime');
    const labelEl = document.getElementById('alarmRingLabel');
    const subEl = document.getElementById('alarmRingSub');
    const pulse = document.getElementById('alarmRingPulse');

    if (alarm) {
      const hDisp = alarm.hour12 === 0 ? 12 : alarm.hour12;
      const mDisp = String(alarm.minute).padStart(2, '0');
      timeEl.textContent = `${hDisp}:${mDisp} ${alarm.ampm}`;
    }

    if (isBetrayal) {
      el.classList.add('alarm-betrayal');
      el.classList.remove('dnd-mode');
      labelEl.textContent = '💰 BACKSTABBED!';
      subEl.textContent = this.getBetrayalDialogue();
      subEl.style.fontStyle = 'italic';
      subEl.style.color = 'var(--danger)';
      // Trigger betrayal sound effect
      Sound.playError();
      Native.hapticAlarm();
      MrClockMood.update();
    } else if (isSilentDND) {
      el.classList.add('dnd-mode');
      el.classList.remove('alarm-betrayal');
      labelEl.textContent = '🌙 SILENT ALARM (DND)';
      subEl.textContent = 'Mr Clock took your $' + DND.getCost() + ' bribe and stayed quiet. Sleep peacefully.';
    } else {
      el.classList.remove('dnd-mode');
      el.classList.remove('alarm-betrayal');
      if (delayMinutes === 0) {
        labelEl.textContent = '⏰ ALARM RINGING';
      } else {
        labelEl.textContent = `⏰ ALARM (${delayMinutes} MIN LATE)`;
      }
      subEl.textContent = this.getDialogue(delayMinutes);
      subEl.style.fontStyle = 'italic';
      subEl.style.color = delayMinutes > 0 ? 'var(--warning)' : 'var(--success)';
    }

    pulse.classList.add('active');
    el.classList.add('ringing');
    document.getElementById('stopBtn').addEventListener('click', () => this.onStop(), { once: true });
  },

  onStop() {
    this.isRinging = false;
    Sound.stopAlarm();
    const el = document.getElementById('alarmScreen');
    el.classList.remove('ringing');
    el.classList.remove('dnd-mode');
    el.classList.remove('alarm-betrayal');
    document.getElementById('alarmRingPulse').classList.remove('active');

    // Reset alarm engine state
    AlarmEngine.isBetrayal = false;

    // Check for new achievements
    Achievements.checkAndUnlock();

    RadialClock.reset();
    State.data.alarm = null;
    State.save();
  },
};

// =============================================
// UI HELPERS
// =============================================

const UI = {
  showAlarmInfo() {
    const el = document.getElementById('alarmInfo');
    if (!el) return;
    el.classList.add('visible');
    const alarm = State.data.alarm;
    if (alarm) {
      const hDisp = alarm.hour12 === 0 ? 12 : alarm.hour12;
      const mDisp = String(alarm.minute).padStart(2, '0');
      document.getElementById('alarmTimeText').textContent = `${hDisp}:${mDisp} ${alarm.ampm}`;
    }
  },

  hideAlarmInfo() {
    const el = document.getElementById('alarmInfo');
    if (el) el.classList.remove('visible');
    document.getElementById('radialHint').classList.remove('hidden');
  },
};

function formatMoney(n) {
  return '$' + Number(n).toLocaleString('en-US');
}

// =============================================
// INIT
// =============================================

function init() {
  Native.init();
  State.load();
  BankBalance.init();
  DND.init();
  RadialClock.init();
  RadialMenu.init();
  Modals.init();
  MrClockMood.update();
  MrClockMood.render();

  if (State.data.alarm) {
    const { hour12, minute, ampm } = State.data.alarm;
    RadialClock.selHour = hour12;
    RadialClock.selMinute = minute;
    RadialClock.selAmPm = ampm;
    RadialClock._renderCountdown(hour12, minute, ampm);
    UI.showAlarmInfo();
    AlarmEngine.start();
    Native.scheduleNotification(State.data.alarm);
  }
}

document.addEventListener('DOMContentLoaded', init);
