# Environment Resource Register

This register lists every external resource the ultra-realistic environments depend on.
Scope: four environments (Lab tank, Harbor, River, Deep sea), browser only, no LLM features, no paid assets.
Most content is built by us; external sources supply measured physics data, CC0 raw materials, and validation imagery.
Research date: 2026-11-18.
Licences marked VERIFIED were read from the licence file, the package registry, or the source API on 2026-11-18.
Everything else was read from search results; re-check it on its source page before the asset enters the repo.

## 1. Licence policy

| Tier | Licences | Allowed use |
|---|---|---|
| A | CC0, public domain, US government works | Ship in the app, train the shipped detector, modify freely |
| B | CC BY 4.0, MIT, Apache-2.0 | Ship and train, with credit on an in-app credits page |
| C | CC BY-NC, CC BY-NC-SA, CC BY-ND, academic only, no redistribution | Never ship, never train the shipped detector; internal realism measurement only, and only while the product is non-commercial |
| X | Unknown, "free" with custom terms, NoAI notices | Do not use |

Rules:

- No asset is committed until its licence is recorded here.
- Tier C files never enter the repo; they live on a local disk and are referenced by script.
- Datasets mirrored on Roboflow or Hugging Face often carry a different licence from the original; the original source always wins.
- `docs/CREDITS.md` (to be created) lists every Tier B item with author, title, licence and link.

## 2. Water optics physics data (Tier A/B, the core of realism)

| Resource | What we take | Source | Licence notes |
|---|---|---|---|
| Pope and Fry 1997, pure water absorption 380-700 nm | Base spectral absorption a_w(lambda) | [omlc.org pope97](https://omlc.org/spectra/water/abs/pope97.html), [OMLC index](https://omlc.org/spectra/water/abs/) | Published measurement data; cite the paper |
| Sogandares and Fry 1997, 340-640 nm | Cross-check of a_w in the blue | [omlc.org sogandares97](https://omlc.org/spectra/water/abs/sogandares97.html) | Cite the paper |
| Solonenko and Mobley 2015, IOPs of Jerlov water types, Applied Optics 54(17):5392 | Spectral a and b for every Jerlov type, 300-700 nm | [DOI 10.1364/AO.54.005392](https://dx.doi.org/10.1364/ao.54.005392) | Tables are in the paper; cite it |
| Williamson and Hollins 2022, measured IOPs of Jerlov water types | Newer measured values; preferred where they disagree with Solonenko | [record](https://bvbvf1.bib-bvb.de/vufind/PrimoRecord/cdi_proquest_miscellaneous_2761985397) | Cite the paper |
| Chlorophyll-based model on Jerlov IOPs (2023) | Green algae water for lake and harbor variants | [record](https://bvbvf1.bib-bvb.de/vufind/PrimoRecord/cdi_proquest_miscellaneous_2864900646) | Cite the paper |
| Ocean Optics Book (Mobley, Boss, et al.) | Jerlov classification, Secchi and NTU relations, phase functions, derivation checks | [classification schemes](https://mail.oceanopticsbook.info/view/inherent-and-apparent-optical-properties/classification-schemes) | Reference text; cite |
| Akkaynak and Treibitz, revised underwater image formation (CVPR 2018) and Sea-thru (CVPR 2019) | Per-channel direct attenuation beta_D and backscatter beta_B model used by the render pass | [Sea-thru paper](https://openaccess.thecvf.com/content_CVPR_2019/papers/Akkaynak_Sea-Thru_A_Method_for_Removing_Water_From_Underwater_Images_CVPR_2019_paper.pdf) | Method, implemented by us |
| Petzold 1972 scattering and Fournier-Forand phase function | Forward-scatter blur kernel shape | Ocean Optics Book, phase function chapter | Published data; cite |
| Bricaud et al. 1981 CDOM absorption | Tannin-brown river water | Paper | Cite |
| ASTM G173-03 solar spectrum | Surface sunlight spectrum before water attenuation | NREL was renamed the National Laboratory of the Rockies on 2025-12-01 and www.nrel.gov no longer resolves; copy in R package [photobiologySun](https://rdrr.io/cran/photobiologySun/man/sun_reference.mspct.html) | Published reference data; the ASTM standard text is paid, the tabulated spectrum is widely republished |
| Francois-Garrison acoustic absorption | Parked until sonar work starts | Paper | Not needed now |

Output of this section: one TypeScript table, `lib/optics/iop.ts`, holding a and b per water type at the camera's three channel centroid wavelengths, plus a script that regenerates it from the source tables.

## 3. Camera and light hardware data (Tier A/B)

| Resource | Use | Source |
|---|---|---|
| Sony IMX708 datasheet (Raspberry Pi Camera Module 3) | Spectral response, pixel pitch, read noise for the default camera | Raspberry Pi documentation and Sony product brief |
| Sony IMX477 (HQ camera) | Second camera preset | Same |
| EMVA 1288 noise model | Shot noise, read noise, dark current, full well in the sensor model | EMVA 1288 standard (free download from EMVA) |
| Dive and ROV light datasheets (lumens, beam angle, CCT) | Light presets for hardware sizing | Vendor sheets; we copy numbers, not text or images |
| Flat-port and dome-port refraction | Port distortion and FOV change | Ocean optics and underwater photogrammetry literature |

## 4. Rendering and runtime libraries (all Tier B, browser only)

| Library | Use | Licence |
|---|---|---|
| `three` (latest 0.187.0, MIT VERIFIED on npm) | Renderer; move to the `WebGPURenderer` with TSL and compute, keep WebGL2 as the fallback tier | MIT |
| three.js `webgpu_volume_lighting` and the WebGPU caustics examples (PR #30962) | Reference for volumetric god rays and shadow-map caustics | MIT (three.js repo) |
| three.js r186+ native Gaussian splat support | Optional scanned-site rendering; requires an upgrade from 0.184 | MIT |
| `@sparkjsdev/spark` | Alternative splat renderer with LoD streaming | MIT, VERIFIED (npm 2.4.0 and GitHub API) |
| `onnxruntime-web` | Built-in detector inference, `executionProviders: ['webgpu', 'wasm']` | MIT, VERIFIED (npm) |
| D-FINE detector | Base architecture for the built-in detector; ONNX export via `tools/deployment/export_onnx.py` | Apache-2.0, VERIFIED (GitHub API, `Peterande/D-FINE` LICENSE) |
| RT-DETR | Fallback detector architecture | Apache-2.0, VERIFIED (GitHub API, `lyuwenyu/RT-DETR`) |
| Ultralytics YOLO | Not used | AGPL-3.0, incompatible with a closed product |
| `three-mesh-bvh` | Fast occlusion and picking | MIT, VERIFIED (GitHub API) |
| `gltf-transform`, meshoptimizer, KTX2 / Basis Universal | Asset compression for streaming | MIT / Apache-2.0 |
| Blender | Asset authoring, baking | GPL for the tool; output assets are ours |

## 5. Surface materials (Tier A)

All CC0.
We use them as raw inputs and author our own layered materials on top (wetness, silt, biofouling masks).

| Source | Licence | What to pull |
|---|---|---|
| [Poly Haven](https://polyhaven.com/license) | CC0 ([FAQ](https://docs.polyhaven.com/en/faq)) | Coastal sand and rocks ([coast_sand_rocks_02](https://polyhaven.com/a/coast_sand_rocks_02)), rocky ground ([rocks_ground_02](https://polyhaven.com/a/rocks_ground_02)), mud ([aerial_mud_1](https://polyhaven.com/a/aerial_mud_1), [mud_cracked_dry_03](https://polyhaven.com/a/mud_cracked_dry_03)), gravel, river pebbles, rusted metal, weathered concrete, wood planks |
| [ambientCG](https://ambientcg.com) | CC0 | Rust, painted metal, concrete, ground, gravel, rock, fabric for rope, terrain heightmaps |
| ShareTextures | CC0 | Extra ground and rock scans |
| [PolyScann](https://polyscann.com/license) | Site says CC0, but its terms also say "Please don't upload our resources to other websites" and forbid redistribution without significant changes | Tier X: the extra terms conflict with shipping files in a public web app; usable only after written confirmation from PolyScann |

Gap: no CC0 source has barnacle, mussel or marine-growth materials.
We build them: procedural barnacle and mussel instancing in Blender, baked to normal and AO, plus a TSL growth mask driven by depth and exposure.

## 6. 3D models

### 6.1 Built by us (the majority)

| Asset | Environments | Method |
|---|---|---|
| Glass tank, sand bed, gantry (exists) | Tank | Already in `components/lab/` |
| Concrete and steel pier pilings with growth | Harbor, River | Blender, CC0 concrete and rust, procedural growth |
| Ship hull section with propeller and anodes | Harbor | Blender |
| Tires, chains, anchor, mooring blocks, shopping cart, crates, ropes | Harbor | Blender, CC0 materials |
| Quay wall and riprap | Harbor | Blender plus rock scans |
| Bridge pier footing with scour hole | River | Blender, terrain sculpt |
| River bed: gravel bars, boulders, logs, branches | River | Procedural terrain plus CC0 rock and gravel |
| Deep-sea mud plain, rock outcrops, debris, a lost instrument frame | Deep sea | Procedural terrain plus CC0 rock |
| Seagrass, weed and algae strands | Harbor, River | Procedural ribbon geometry with TSL sway |
| Marine snow, silt, bubbles | All | GPU particles in TSL compute |
| Water surface seen from below, Snell's window | Tank, Harbor, River | TSL shader |
| Light rigs (spot and flood heads) | All | Blender |

### 6.2 External models

| Asset | Source | Licence | Status |
|---|---|---|---|
| Fish, 50+ animated low-poly species | [Quaternius Lowpoly Animated Fish](https://quaternius.itch.io/lowpoly-animated-fish), [OpenGameArt copy](https://opengameart.org/content/animated-fish) | CC0 | Usable as rig and motion base; geometry and textures need a realism upgrade by us |
| Smithsonian Open Access 3D | [si.edu open access](https://www.si.edu/openaccess/updates/21st-century-diffusion), [FAQ](https://dashboard.si.edu/openaccess/faq) | CC0 where marked; glTF/GLB/OBJ | Search the CC0 filter for maritime objects (anchors, hull parts, buoys) |
| Mukran wreck photogrammetry, 600k faces | [Sketchfab](https://sketchfab.com/3d-models/mukran-wreck-86a7f98951f047ff848510537de4a677) | CC BY, VERIFIED (Sketchfab API), downloadable | Candidate wreck for the River or Harbor scene; Tier B, credit required |
| Gigha pier leg, ROV scan, 2.3M triangles | [Sketchfab](https://www.sketchfab.com/3d-models/gigha-pier-leg-e778044be2f542aabcd0e2a086cb9669) | No licence, not downloadable (Sketchfab API) | Visual reference only; we model our own pilings |
| Shipwreck anchor, Zeewijk 1727, 911k faces | [Sketchfab](https://sketchfab.com/3d-models/zeewijk-1727-shipwreck-anchor-7429ca4f6e1548d09bcdd8e1a27493dc) | CC BY, VERIFIED (Sketchfab API), downloadable | Harbor anchor; Tier B, credit required |
| Kelp | [Meshy Emerald Seaweed](https://www.meshy.ai/cs/3d-models/Emerald-Seaweed-019cb8bb-af10-7e6c-a03a-6609e19df461) | CC0 claimed | Quality unknown; procedural kelp by us is the default |
| Kelp | Production Crate [Kelp 1](https://learn.productioncrate.com/objects/rendercrate-kelp-1), [Kelp 2](https://www.productioncrate.com/objects/rendercrate-kelp-2) | Custom "free, no attribution" | Tier X until terms allow redistribution in a web app |

Sketchfab search plan: filter by CC0 and CC BY, query "piling", "mussels", "marine debris", "harbor", "wreck", "anchor"; reject anything NC, ND or with a NoAI notice.

## 7. Terrain and bathymetry (Tier A/B)

| Source | Use | Licence |
|---|---|---|
| [GEBCO Grid](https://www.gebco.net/data-products/gridded-bathymetry/terms-of-use) | Large-scale deep-sea relief | Public domain, commercial use allowed, attribution required, no endorsement implied |
| [NOAA NCEI NOS hydrographic surveys (BAG)](https://www.ncei.noaa.gov/products/nos-hydrographic-survey) | Real harbor and river-mouth beds at metre resolution | US government data; check "Other Constraints" per survey for citation terms |
| [NOAA Multibeam Bathymetry Database](https://catalog.data.gov/dataset/multibeam-bathymetry-database-mbbdb) | Deep-sea detail | Same |

## 8. Real imagery for realism validation and detector training

### 8.1 Usable for training the shipped detector (Tier A/B)

| Dataset | Content | Licence | Matches |
|---|---|---|---|
| [Brackish dataset](https://www.kaggle.com/datasets/aalborguniversity/brackish-dataset), Aalborg University | 14,674 frames from 9 m depth under a Limfjord bridge, varying visibility, 6 classes | CC BY-SA 4.0, VERIFIED (official AAU Kaggle release via Kaggle API); the Roboflow mirror's CC BY 4.0 does not apply | Harbor, River; ShareAlike may extend to trained weights, so use it for validation and keep it out of shipped weights unless we accept CC BY-SA on them |
| USGS Elwha River underwater transect videos | Strong current, heavy suspended sediment, "very poor visibility" | Public domain: USGS says "USGS-authored or produced data and information are considered to be in the U.S. Public Domain" ([FAQ](https://www.usgs.gov/faqs/are-usgs-reports-copyrighted)); third-party items on USGS pages are excepted, so check each video's credit line ([example](https://www.usgs.gov/media/videos/c2-east-transect-2017)); usgs.gov blocks automated fetches | River; best real turbid-river reference found |
| NOAA National Marine Sanctuaries media | Coastal and reef imagery | Most items public domain, but the [media page](https://sanctuaries.noaa.gov/news/media/) offers them for news media and non-commercial scientific and educational use, and items not credited to a US agency may be copyrighted | Tier C unless an item is credited to NOAA staff; check per item |
| FathomNet, CC-BY records only | Deep-sea imagery | Per-record `image_license` field ([AWS registry](https://registry.opendata.aws/fathomnet/)); filter to CC0 and CC BY | Deep sea |
| SUIM | Seabed, wreck, reef segmentation | Repo LICENSE is MIT, VERIFIED, but it grants rights to "the Software" only; no image licence found and the dataset page blocks automated fetches | Tier X for images until the authors state an image licence |

### 8.2 Validation only, never shipped or trained (Tier C)

| Dataset | Licence | Use |
|---|---|---|
| [Sea-thru](https://www.viseaon.haifa.ac.il/datasets), RAW plus depth maps | CC BY-NC-SA per a third-party mirror; official terms unconfirmed | Fit and check beta_D and beta_B against real RAW plus depth |
| [UIEB](https://li-chongyi.github.io/proj_benchmark) | Academic only, no redistribution | Colour-cast statistics |
| [TrashCan](https://conservancy.umn.edu/items/6dd6a960-c44a-4510-a679-efb8c82ebfb7) | Academic and personal; commercial needs a JAMSTEC licence | Debris appearance |
| FathomNet FGVC 2023 subset | Images CC BY-NC-ND | None |
| RUOD, DUO, URPC | Licence unstated; DUO inherits URPC and UDD terms | Tier X until the authors confirm |

### 8.3 Our own capture (the strongest source, Tier A)

- The physical GANTRYLAB tank with a turbidity meter, kaolin added in measured NTU steps, a Secchi disk and a colour chart.
- Gantry-camera RAW stills at each step and at three distances.
- This set calibrates the Lab tank, then anchors the extrapolation to the other water types.

## 9. Per-environment bill of materials

### Lab tank

- Water: Jerlov I plus kaolin turbidity calibrated against our capture.
- Implemented: 0 to 20 NTU kaolin, CDOM 0.01 m^-1, sand reflectance 0.25 (`lib/sim/environments.ts`).
- Existing models; upgrade glass (refraction, edge tint), sand (displacement, ripples), meniscus.
- Ground truth: our own capture (8.3).

### Harbor

- Water: coastal 5C to 9C, chlorophyll variant, 5-50 NTU.
- Implemented: 1 to 40 NTU, CDOM 0.12 m^-1, mineral silt (albedo 0.92), mud reflectance 0.12, 6 m column in daylight emulated in the tank; the chlorophyll variant is not modelled yet.
- Bed: NOAA BAG patch, mud and silt materials, shell hash.
- Props: pilings with growth, hull section, tires, chains, anchor, mooring block, crates, ropes, seagrass.
- Life: Quaternius fish, upgraded.
- Validation: Brackish dataset, NOAA sanctuaries imagery.

### River

- Water: CDOM tannin brown plus suspended sediment, 10-500 NTU, current.
- Implemented: 2 to 150 NTU, CDOM 0.9 m^-1, spectrally flat fine sediment (albedo 0.95), gravel reflectance 0.18, 1.2 m column in daylight emulated in the tank; spates above 150 NTU are not covered yet.
- Bed: gravel bars, boulders, logs, scour hole at a bridge footing.
- Particles: sediment plume advected by the current field.
- Validation: USGS Elwha transects, Brackish.

### Deep sea

- Water: Jerlov I to II optics, no sunlight below the photic zone.
- Bed: GEBCO relief, mud plain, rock outcrops, debris, a lost instrument frame.
- Light: artificial only; backscatter and marine snow dominate.
- Implemented: 0.02 to 2 NTU, CDOM 0.005 m^-1, ooze reflectance 0.3, lamp light from the lens only.
- Validation: FathomNet CC-BY records.

## 10. Verification status

Done on 2026-11-18:

1. D-FINE: Apache-2.0, VERIFIED.
2. Brackish: CC BY-SA 4.0 on the official release, VERIFIED; the earlier CC BY 4.0 reading came from a mirror.
3. NOAA Sanctuaries media: not CC0; non-commercial wording; moved to Tier C.
4. SUIM: MIT covers code only; images Tier X.
5. PolyScann: extra terms conflict with web delivery; Tier X.
6. Sketchfab: Mukran wreck and Zeewijk anchor are CC BY and downloadable; the Gigha pier leg has no licence.
7. ASTM G173: the NREL domain is gone; use the photobiologySun copy.

Still open:

1. Smithsonian 3D: 3d.si.edu returns 403 to automated clients and the Open Access API with `DEMO_KEY` returned no 3D rows; search the CC0 filter by hand in a browser.
2. Pull the Solonenko and Mobley and the Williamson and Hollins tables (paywalled Applied Optics; needs library access or the Ocean Optics Book tables).
