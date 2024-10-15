"use strict";

window.Submap = (function () {
  /*
    generate new map based on an existing one (resampling parentMap)
    parentMap: {grid, pack, notes} from original map
    options = {
      smoothHeightmap: Bool; run smooth filter on heights
      depressRivers: Bool; lower elevation of riverbed cells
      projection: f(Number, Number) -> [Number, Number]
      inverse: f(Number, Number) -> [Number, Number]
    }
    */
  function resample(parentMap, options) {
    const {projection, inverse} = options;

    grid = generateGrid();
    pack = {};
    notes = parentMap.notes;

    resamplePrimaryGridData(parentMap, inverse);

    Features.markupGrid();
    addLakesInDeepDepressions();
    openNearSeaLakes();

    OceanLayers();
    calculateMapCoordinates();
    calculateTemperatures();
    generatePrecipitation();

    reGraph();
    Features.markupPack();
    createDefaultRuler();

    Rivers.generate();
    Biomes.define();

    rankCells();

    restoreSecondaryCellData(parentMap, inverse);
    restoreCultures(parentMap, projection);
    restoreBurgs(parentMap, projection, options);
    restoreStates(parentMap, projection);
    restoreReligions(parentMap, projection);
    restoreProvinces(parentMap);
    restoreMarkers(parentMap, projection);
    restoreZones(parentMap, projection, options);

    Routes.generate();

    Rivers.specify();
    Features.specify();

    showStatistics();
  }

  function resamplePrimaryGridData(parentMap, inverse) {
    grid.cells.h = new Uint8Array(grid.points.length);
    grid.cells.temp = new Int8Array(grid.points.length);
    grid.cells.prec = new Uint8Array(grid.points.length);

    grid.points.forEach(([x, y], newGridCell) => {
      const [parentX, parentY] = inverse(x, y);
      const parentPackCell = parentMap.pack.cells.q.find(parentX, parentY, Infinity)[2];
      const parentGridCell = parentMap.pack.cells.g[parentPackCell];

      grid.cells.h[newGridCell] = parentMap.grid.cells.h[parentGridCell];
      grid.cells.temp[newGridCell] = parentMap.grid.cells.temp[parentGridCell];
      grid.cells.prec[newGridCell] = parentMap.grid.cells.prec[parentGridCell];
    });

    if (options.smoothHeightmap) smoothHeightmap();
    if (options.depressRivers) depressRivers(parentMap, inverse);
  }

  function smoothHeightmap() {
    grid.cells.h.forEach((height, newGridCell) => {
      const heights = [height, ...grid.cells.c[newGridCell].map(c => grid.cells.h[c])];
      const meanHeight = d3.mean(heights);
      grid.cells.h[newGridCell] = isWater(grid, newGridCell) ? Math.min(meanHeight, 19) : Math.max(meanHeight, 20);
    });
  }

  function depressRivers(parentMap, inverse) {
    // lower elevation of cells with rivers by 1
    grid.cells.points.forEach(([x, y], newGridCell) => {
      const [parentX, parentY] = inverse(x, y);
      const parentPackCell = parentMap.pack.cells.q.find(parentX, parentY, Infinity)[2];
      const hasRiver = Boolean(parentMap.pack.cells.r[parentPackCell]);
      if (hasRiver && grid.cells.h[newGridCell] > 20) grid.cells.h[newGridCell] -= 1;
    });
  }

  function restoreSecondaryCellData(parentMap, inverse) {
    pack.cells.culture = new Uint16Array(pack.cells.i.length);
    pack.cells.state = new Uint16Array(pack.cells.i.length);
    pack.cells.burg = new Uint16Array(pack.cells.i.length);
    pack.cells.religion = new Uint16Array(pack.cells.i.length);
    pack.cells.province = new Uint16Array(pack.cells.i.length);

    const parentPackCellGroups = groupCellsByType(parentMap.pack);
    const parentPackLandCellsQuadtree = d3.quadtree(parentPackCellGroups.land);

    for (const newPackCell of pack.cells.i) {
      const [x, y] = inverse(...pack.cells.p[newPackCell]);

      if (isWater(pack, newPackCell)) {
      } else {
        const parentPackCell = parentPackLandCellsQuadtree.find(x, y, Infinity)[2];
        pack.cells.culture[newPackCell] = parentMap.pack.cells.culture[parentPackCell];
        pack.cells.state[newPackCell] = parentMap.pack.cells.state[parentPackCell];
        pack.cells.religion[newPackCell] = parentMap.pack.cells.religion[parentPackCell];
        pack.cells.province[newPackCell] = parentMap.pack.cells.province[parentPackCell];
      }
    }
  }

  function restoreCultures(parentMap, projection) {
    const validCultures = new Set(pack.cells.culture);
    const culturePoles = getPolesOfInaccessibility(pack, cellId => pack.cells.culture[cellId]);
    pack.cultures = parentMap.pack.cultures.map(culture => {
      if (!culture.i || culture.removed) return culture;
      if (!validCultures.has(culture.i)) return {...culture, removed: true, lock: false};

      const [xp, yp] = projection(...parentMap.pack.cells.p[culture.center]);
      const [x, y] = [rn(xp, 2), rn(yp, 2)];
      const centerCoords = isInMap(x, y) ? [x, y] : culturePoles[culture.i];
      const center = findCell(...centerCoords);
      return {...culture, center};
    });
  }

  function restoreBurgs(parentMap, projection, options) {
    const packLandCellsQuadtree = d3.quadtree(groupCellsByType(pack).land);

    pack.burgs = parentMap.pack.burgs.map(burg => {
      if (!burg.i || burg.removed) return burg;
      burg.population *= options.scale; // adjust for populationRate change

      const [xp, yp] = projection(burg.x, burg.y);
      const [x, y] = [rn(xp, 2), rn(yp, 2)];
      if (!isInMap(x, y)) return {...burg, removed: true, lock: false};

      const cell = packLandCellsQuadtree.find(x, y, Infinity)?.[2];
      if (!cell) {
        ERROR && console.error(`Could not find cell for burg ${burg.name} (${burg.i}). Had to remove it`);
        return {...burg, removed: true, lock: false};
      }
      if (pack.cells.burg[cell]) {
        WARN && console.warn(`Cell ${cell} already has a burg. Had to remove burg ${burg.name} (${burg.i})`);
        return {...burg, removed: true, lock: false};
      }

      pack.cells.burg[cell] = burg.i;
      return {...burg, x, y, cell};
    });
  }

  function restoreStates(parentMap, projection) {
    const validStates = new Set(pack.cells.state);
    pack.states = parentMap.pack.states.map(state => {
      if (!state.i || state.removed) return state;
      if (!validStates.has(state.i)) return {...state, removed: true, lock: false};

      const military = state.military.map(regiment => {
        const cell = findCell(...projection(...parentMap.pack.cells.p[regiment.cell]));
        const [xBase, yBase] = projection(regiment.bx, regiment.by);
        const [xCurrent, yCurrent] = projection(regiment.x, regiment.y);
        return {...regiment, cell, bx: rn(xBase, 2), by: rn(yBase, 2), x: rn(xCurrent, 2), y: rn(yCurrent, 2)};
      });

      const neighbors = state.neighbors.filter(stateId => validStates.has(stateId));
      return {...state, neighbors, military};
    });

    BurgsAndStates.getPoles();

    pack.states.forEach(state => {
      if (!state.i || state.removed) return;
      const capital = pack.burgs[state.capital];
      state.center = !capital?.removed ? capital.cell : findCell(...state.pole);
    });
  }

  function restoreReligions(parentMap, projection) {
    const validReligions = new Set(pack.cells.religion);
    const religionPoles = getPolesOfInaccessibility(pack, cellId => pack.cells.religion[cellId]);

    pack.religions = parentMap.pack.religions.map(religion => {
      if (!religion.i || religion.removed) return religion;
      if (!validReligions.has(religion.i)) return {...religion, removed: true, lock: false};

      const [xp, yp] = projection(...parentMap.pack.cells.p[religion.center]);
      const [x, y] = [rn(xp, 2), rn(yp, 2)];
      const centerCoords = isInMap(x, y) ? [x, y] : religionPoles[religion.i];
      const center = findCell(...centerCoords);
      return {...religion, center};
    });
  }

  function restoreProvinces(parentMap) {
    const validProvinces = new Set(pack.cells.province);
    pack.provinces = parentMap.pack.provinces.map(province => {
      if (!province.i || province.removed) return province;
      if (!validProvinces.has(province.i)) return {...province, removed: true, lock: false};

      return province;
    });

    Provinces.getPoles();

    pack.provinces.forEach(province => {
      if (!province.i || province.removed) return;
      const capital = pack.burgs[province.burg];
      province.center = !capital?.removed ? capital.cell : findCell(...province.pole);
    });
  }

  function restoreMarkers(parentMap, projection) {
    pack.markers = parentMap.pack.markers;
    pack.markers.forEach(marker => {
      const [x, y] = projection(marker.x, marker.y);
      if (!isInMap(x, y)) Markers.deleteMarker(marker.i);

      const cell = findCell(x, y);
      marker.x = rn(x, 2);
      marker.y = rn(y, 2);
      marker.cell = cell;
    });
  }

  function restoreZones(parentMap, projection, options) {
    const getSearchRadius = cellId => Math.sqrt(parentMap.pack.cells.area[cellId] / Math.PI) * options.scale;

    pack.zones = parentMap.pack.zones.map(zone => {
      const cells = zone.cells
        .map(cellId => {
          const [x, y] = projection(...parentMap.pack.cells.p[cellId]);
          if (!isInMap(x, y)) return null;
          return findAll(x, y, getSearchRadius(cellId));
        })
        .filter(Boolean)
        .flat();

      return {...zone, cells: unique(cells)};
    });
  }

  function groupCellsByType(graph) {
    return graph.cells.p.reduce(
      (acc, [x, y], cellId) => {
        const group = isWater(graph, cellId) ? "water" : "land";
        acc[group].push([x, y, cellId]);
        return acc;
      },
      {land: [], water: []}
    );
  }

  function isWater(graph, cellId) {
    return graph.cells.h[cellId] < 20;
  }

  function isInMap(x, y) {
    return x >= 0 && x <= graphWidth && y >= 0 && y <= graphHeight;
  }

  return {resample};
})();
