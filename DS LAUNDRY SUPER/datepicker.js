// ============================================================
//  DS Universal Date Picker — lightweight, dependency-free
//  Replaces the native <input type="date"> UI (which looks and
//  behaves differently on every browser/OS) with one consistent,
//  custom-styled popover calendar used everywhere in the app.
//
//  The input keeps storing a plain "YYYY-MM-DD" string in .value
//  and still fires a normal "change" event, so every onchange=""
//  handler and every place that does input.value.split('-') keeps
//  working with zero changes elsewhere.
//
//  Usage: mark any input with data-ds-calendar="1" and it will be
//  auto-initialized on load. Dynamically-added inputs can call
//  window.initDsDatePicker('the-input-id') manually.
// ============================================================
(function () {
  let openPop = null;      // currently open popover (only one at a time)
  let openInput = null;
  let openField = null;    // the .ds-cal-field wrapper, if any, for the focus-ring class

  function pad(n) { return String(n).padStart(2, '0'); }
  function toKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parseKey(key) {
    if (!key) return null;
    const parts = key.split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    const [y, m, d] = parts;
    return new Date(y, m - 1, d);
  }

  function closePicker() {
    if (openField) openField.classList.remove('ds-cal-field-open');
    if (openPop) { openPop.remove(); openPop = null; openInput = null; openField = null; }
    document.removeEventListener('mousedown', onDocClick, true);
    window.removeEventListener('resize', closePicker);
    window.removeEventListener('scroll', closePicker, true);
    closeRangePicker(); // only one popover (single-date or range) is ever open at once
  }
  function onDocClick(e) {
    if (openPop && !openPop.contains(e.target) && e.target !== openInput) closePicker();
  }

  function setValue(input, key) {
    input.value = key;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function buildCalendar(input) {
    if (openInput === input) { closePicker(); return; } // click again to toggle closed
    closePicker();
    closeRangePicker(); // if a range popover was open, close it first

    const today = new Date();
    const selectedDate = parseKey(input.value);
    let viewYear  = (selectedDate || today).getFullYear();
    let viewMonth = (selectedDate || today).getMonth();

    const pop = document.createElement('div');
    pop.className = 'ds-cal-pop';

    function render() {
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const first = new Date(viewYear, viewMonth, 1);
      const startDow = (first.getDay() + 6) % 7; // Monday = 0
      const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
      const todayKey = toKey(today);
      const selKey = selectedDate ? toKey(selectedDate) : null;

      let cells = '';
      for (let i = 0; i < startDow; i++) cells += `<span class="ds-cal-cell empty"></span>`;
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${viewYear}-${pad(viewMonth + 1)}-${pad(d)}`;
        const isToday = key === todayKey;
        const isSel = key === selKey;
        cells += `<button type="button" class="ds-cal-cell${isToday ? ' today' : ''}${isSel ? ' selected' : ''}" data-key="${key}">${d}</button>`;
      }

      pop.innerHTML = `
        <div class="ds-cal-head">
          <button type="button" class="ds-cal-nav" data-nav="-1" aria-label="Previous month">‹</button>
          <div class="ds-cal-title">${monthNames[viewMonth]} ${viewYear}</div>
          <button type="button" class="ds-cal-nav" data-nav="1" aria-label="Next month">›</button>
        </div>
        <div class="ds-cal-dow"><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span></div>
        <div class="ds-cal-grid">${cells}</div>
        <div class="ds-cal-foot">
          <button type="button" class="ds-cal-btn ds-cal-today">Today</button>
          <button type="button" class="ds-cal-btn ds-cal-clear">Clear</button>
        </div>`;

      pop.querySelector('[data-nav="-1"]').onclick = () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } render(); };
      pop.querySelector('[data-nav="1"]').onclick  = () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } render(); };
      pop.querySelectorAll('.ds-cal-cell[data-key]').forEach(cell => {
        cell.onclick = () => { setValue(input, cell.dataset.key); closePicker(); };
      });
      pop.querySelector('.ds-cal-today').onclick = () => { setValue(input, toKey(new Date())); closePicker(); };
      pop.querySelector('.ds-cal-clear').onclick = () => { setValue(input, ''); closePicker(); };
    }
    render();

    document.body.appendChild(pop);
    const r = input.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let left = r.left + window.scrollX;
    if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
    if (left < 8) left = 8;
    let top = r.bottom + window.scrollY + 6;
    if (r.bottom + popRect.height + 6 > window.innerHeight) top = r.top + window.scrollY - popRect.height - 6; // flip above if no room below
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';

    openPop = pop;
    openInput = input;
    openField = input.closest('.ds-cal-field');
    if (openField) openField.classList.add('ds-cal-field-open');
    setTimeout(() => {
      document.addEventListener('mousedown', onDocClick, true);
      window.addEventListener('resize', closePicker);
      window.addEventListener('scroll', closePicker, true);
    }, 0);
  }

  window.initDsDatePicker = function (id) {
    const input = document.getElementById(id);
    if (!input || input.dataset.dsCalReady) return;
    input.dataset.dsCalReady = '1';
    input.setAttribute('readonly', 'readonly'); // block native keyboard/OS date UI
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('inputmode', 'none'); // stops mobile keyboards from popping up
    if (!input.placeholder) input.placeholder = 'Select date';
    input.addEventListener('paste', e => e.preventDefault());
    input.addEventListener('click', () => buildCalendar(input));
    input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); buildCalendar(input); } });
  };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('input[data-ds-calendar]').forEach(el => window.initDsDatePicker(el.id));
  });

  // ============================================================
  //  RANGE MODE — ONE calendar shared by a "From" + "To" input.
  //  Click either input to open a single popover. First click on
  //  a day sets the start, second click sets the end (auto-swaps
  //  if picked out of order) and commits both inputs + closes.
  //  Hovering while only the start is picked previews the range.
  // ============================================================
  let openRangePop = null;
  let openRangeState = null; // { fromInput, toInput, fromField, toField }

  function closeRangePicker() {
    if (openRangeState) {
      if (openRangeState.fromField) openRangeState.fromField.classList.remove('ds-cal-field-open');
      if (openRangeState.toField)   openRangeState.toField.classList.remove('ds-cal-field-open');
    }
    if (openRangePop) { openRangePop.remove(); openRangePop = null; }
    openRangeState = null;
    document.removeEventListener('mousedown', onRangeDocClick, true);
    window.removeEventListener('resize', closeRangePicker);
    window.removeEventListener('scroll', closeRangePicker, true);
  }
  function onRangeDocClick(e) {
    if (openRangePop && !openRangePop.contains(e.target) &&
        e.target !== openRangeState?.fromInput && e.target !== openRangeState?.toInput) {
      closeRangePicker();
    }
  }

  function buildRangeCalendar(fromInput, toInput, anchorInput) {
    // click again on either field of an already-open pair toggles it closed
    if (openRangeState && openRangeState.fromInput === fromInput && openRangeState.toInput === toInput) {
      closeRangePicker();
      return;
    }
    closePicker();       // only one popover (single-date or range) at a time
    closeRangePicker();

    const today = new Date();
    let rangeStart = parseKey(fromInput.value);
    let rangeEnd   = parseKey(toInput.value);
    let viewYear   = (rangeStart || today).getFullYear();
    let viewMonth  = (rangeStart || today).getMonth();
    let hoverKey   = null; // live preview end while only the start is picked

    const pop = document.createElement('div');
    pop.className = 'ds-cal-pop ds-cal-pop-range';

    function commitAndClose() {
      let s = rangeStart, e = rangeEnd;
      if (toKey(s) > toKey(e)) { const t = s; s = e; e = t; }
      setValue(fromInput, toKey(s));
      setValue(toInput, toKey(e));
      closeRangePicker();
    }

    function render() {
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const first = new Date(viewYear, viewMonth, 1);
      const startDow = (first.getDay() + 6) % 7; // Monday = 0
      const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
      const todayKey = toKey(today);
      const startKey = rangeStart ? toKey(rangeStart) : null;
      const endKey   = rangeEnd ? toKey(rangeEnd) : null;

      let cells = '';
      for (let i = 0; i < startDow; i++) cells += `<span class="ds-cal-cell empty"></span>`;
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${viewYear}-${pad(viewMonth + 1)}-${pad(d)}`;
        const isToday = key === todayKey;
        const isStart = key === startKey;
        const isEnd   = key === endKey;
        const inRange = startKey && endKey && key > (startKey < endKey ? startKey : endKey) && key < (startKey < endKey ? endKey : startKey);
        let cls = 'ds-cal-cell';
        if (isToday) cls += ' today';
        if (isStart || isEnd) cls += ' selected range-endpoint';
        if (isStart) cls += ' range-start';
        if (isEnd) cls += ' range-end';
        if (inRange) cls += ' in-range';
        cells += `<button type="button" class="${cls}" data-key="${key}">${d}</button>`;
      }

      const label = rangeStart && rangeEnd
        ? `${toKey(rangeStart)} → ${toKey(rangeEnd)}`
        : rangeStart
          ? `${toKey(rangeStart)} → pick end date`
          : 'Pick a start date';

      pop.innerHTML = `
        <div class="ds-cal-head">
          <button type="button" class="ds-cal-nav" data-nav="-1" aria-label="Previous month">‹</button>
          <div class="ds-cal-title">${monthNames[viewMonth]} ${viewYear}</div>
          <button type="button" class="ds-cal-nav" data-nav="1" aria-label="Next month">›</button>
        </div>
        <div class="ds-cal-range-label">${label}</div>
        <div class="ds-cal-dow"><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span></div>
        <div class="ds-cal-grid">${cells}</div>
        <div class="ds-cal-foot">
          <button type="button" class="ds-cal-btn ds-cal-today">Today</button>
          <button type="button" class="ds-cal-btn ds-cal-clear">Clear</button>
        </div>`;

      pop.querySelector('[data-nav="-1"]').onclick = () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } render(); };
      pop.querySelector('[data-nav="1"]').onclick  = () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } render(); };

      const grid = pop.querySelector('.ds-cal-grid');
      const cellEls = Array.from(grid.querySelectorAll('.ds-cal-cell[data-key]'));

      cellEls.forEach(cell => {
        cell.onclick = () => {
          const clicked = parseKey(cell.dataset.key);
          if (!rangeStart || (rangeStart && rangeEnd)) {
            // starting a brand new selection
            rangeStart = clicked;
            rangeEnd = null;
            hoverKey = null;
            render();
          } else {
            // second click completes the range (auto-swap handled in commitAndClose)
            rangeEnd = clicked;
            commitAndClose();
          }
        };
      });

      // Live hover preview of the range while only the start is chosen
      grid.onmouseover = (e) => {
        if (!rangeStart || rangeEnd) return;
        const cell = e.target.closest('.ds-cal-cell[data-key]');
        if (!cell) return;
        hoverKey = cell.dataset.key;
        const lo = startKey < hoverKey ? startKey : hoverKey;
        const hi = startKey < hoverKey ? hoverKey : startKey;
        cellEls.forEach(c => {
          const k = c.dataset.key;
          c.classList.toggle('in-range-hover', k > lo && k < hi);
          c.classList.toggle('range-end-hover', k === hoverKey && k !== startKey);
        });
      };
      grid.onmouseleave = () => {
        if (!rangeStart || rangeEnd) return;
        hoverKey = null;
        cellEls.forEach(c => { c.classList.remove('in-range-hover', 'range-end-hover'); });
      };

      pop.querySelector('.ds-cal-today').onclick = () => {
        const t = new Date();
        rangeStart = t; rangeEnd = t;
        commitAndClose();
      };
      pop.querySelector('.ds-cal-clear').onclick = () => {
        setValue(fromInput, '');
        setValue(toInput, '');
        closeRangePicker();
      };
    }
    render();

    document.body.appendChild(pop);
    const r = anchorInput.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let left = r.left + window.scrollX;
    if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
    if (left < 8) left = 8;
    let top = r.bottom + window.scrollY + 6;
    if (r.bottom + popRect.height + 6 > window.innerHeight) top = r.top + window.scrollY - popRect.height - 6; // flip above if no room below
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';

    openRangePop = pop;
    openRangeState = {
      fromInput, toInput,
      fromField: fromInput.closest('.ds-cal-field'),
      toField: toInput.closest('.ds-cal-field'),
    };
    if (openRangeState.fromField) openRangeState.fromField.classList.add('ds-cal-field-open');
    if (openRangeState.toField)   openRangeState.toField.classList.add('ds-cal-field-open');
    setTimeout(() => {
      document.addEventListener('mousedown', onRangeDocClick, true);
      window.addEventListener('resize', closeRangePicker);
      window.addEventListener('scroll', closeRangePicker, true);
    }, 0);
  }

  // Wire a "From" + "To" input pair to ONE shared range calendar.
  window.initDsDateRange = function (fromId, toId) {
    const fromInput = document.getElementById(fromId);
    const toInput   = document.getElementById(toId);
    if (!fromInput || !toInput || fromInput.dataset.dsRangeReady) return;
    fromInput.dataset.dsRangeReady = '1';
    toInput.dataset.dsRangeReady = '1';

    [fromInput, toInput].forEach(inp => {
      inp.setAttribute('readonly', 'readonly');
      inp.setAttribute('autocomplete', 'off');
      inp.setAttribute('inputmode', 'none');
      if (!inp.placeholder) inp.placeholder = 'Select date';
      inp.addEventListener('paste', e => e.preventDefault());
      inp.addEventListener('click', () => buildRangeCalendar(fromInput, toInput, inp));
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); buildRangeCalendar(fromInput, toInput, inp); }
      });
    });
  };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-ds-range-from]').forEach(el => {
      const toId = el.getAttribute('data-ds-range-from');
      if (toId) window.initDsDateRange(el.id, toId);
    });
  });
})();