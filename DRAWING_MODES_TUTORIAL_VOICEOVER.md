# Drawing Modes Tutorial Voice-Over Script

**Audience:** Hobby CAD/CAM/CNC users
**Working title:** Drawing Modes in PureCutCNC: Model, Paths, Regions, and Construction

## Opening

In PureCutCNC, the shape you draw and the role you give it are separate decisions.

A rectangle, circle, spline, or composite profile is just geometry. The drawing mode tells PureCutCNC what that geometry means: does it become material in the model, a cut path, a CAM boundary, or simply a construction reference?

Before drawing the model, take a moment to define your stock boundaries and its thickness, or depth. The stock is not just a background rectangle: it defines the starting material and provides the default top-Z reference for the features you create. You can change an individual feature's Z values later in the Properties panel, but setting up the stock first gives the model and its toolpaths a sensible starting point. We will cover stock definition in its own video; for now, think of it as the physical blank from which the rest of this design is made.

The four drawing modes are Features, Lines, Regions, and Construction.

- **Features** create model geometry: material to add or remove.
- **Lines** create machinable paths with no solid volume.
- **Regions** are CAM masks that define where machining is allowed or excluded.
- **Construction** creates reference geometry for layout and measurement; it is never machined.

You select the mode from the creation-target buttons, and the badge on the canvas confirms what you are about to draw. Get into the habit of checking that badge before placing geometry. A perfectly drawn shape in the wrong mode can produce a very different result. But do not panic if that happens: select the shape and change its role in the Properties panel rather than redrawing it from scratch.

## Feature Mode

Let us start with Feature mode.

Feature mode is for geometry that contributes to the physical model: an added boss, a pocket, a through-cut, or an internal cutout.

For this example, select Feature mode, choose Rectangle, and draw the outer boundary of a small panel. This first closed feature establishes material in the part. In the 3D view, it becomes a solid volume.

Now draw a smaller closed rectangle inside it. PureCutCNC uses the nesting of closed solid geometry to determine whether it represents added material or removed material. In this example, the inner rectangle becomes a subtractive feature: a pocket or cutout in the panel. Always check the role shown in the feature tree or Properties panel after creating geometry, especially when your design contains overlapping or nested profiles.

The important point is that Feature mode is model-aware. Closed profiles participate in the add-and-subtract solid model. Their top and bottom Z values define the vertical extent of the material. The initial top-Z value comes from the stock setup, which is why defining stock before drawing saves cleanup later. If one feature needs to start below the stock surface, or rise above it, edit that feature's Z values in the Properties panel.

That matters directly to CAM. A subtractive feature can provide the boundary for a Pocket operation. Its vertical span tells PureCutCNC how deep the feature is, while the profile tells the toolpath generator where the wall and floor should be. Additive geometry establishes the material that remains and the exterior boundaries used by operations such as outside edge routing.

A useful rule is this: if the shape represents actual material or actual removed material, begin in Feature mode.

One caveat: an open profile cannot create a solid. If you draw an open shape, it behaves as path geometry rather than a volume. For deliberate engraving, scoring, or open-contour cutting, use Line mode instead.

## Line Mode

Line mode creates machinable geometry without creating or removing solid volume in the 3D model.

Select Line mode and choose a shape, perhaps a Composite path. Click to place a few straight segments. In composite drawing, you can also switch between line, arc, and spline segments as you build a single path. Finish the profile when the path is complete.

Unlike a feature, this path does not become a wall, pocket, or island in the 3D model. It is a centerline or contour that a cutter can follow.

This is the right mode for engraving text-like paths, decorative inlays represented by centerlines, score marks, layout lines you actually intend to cut, and open geometry that has no enclosed area.

For CAM, Line mode is most naturally paired with a Follow Line operation. The cutter follows the geometry itself at the selected carving depth, using the operation's stepdown and tool settings. A closed line can also be followed around its contour, but it is still a path, not an enclosed pocket area. PureCutCNC will not clear the interior simply because the line happens to form a loop.

That distinction is important. If you want to remove all material inside a shape, use a subtractive Feature and a Pocket operation. If you want the cutter to trace a line, use Line mode and Follow Line.

For drilling, circular machinable geometry can also provide the center information used by a Drilling operation. Again, use the mode deliberately: a line circle describes a path or center, while a subtractive feature describes actual removed cylindrical material.

## Region Mode

Region mode is for controlling CAM, not for changing the model.

Select Region mode, choose a closed shape such as a rectangle, circle, polygon, or spline, and draw it over part of the panel. Notice that this region does not add material, remove material, or create a solid wall in the model. It is a machining-area definition.

Think of a region as a CAM mask.

An include region limits an operation to the area inside that boundary. This is useful when you want to surface only one section of a board, clear a pocket only in a specific zone, or restrict an operation while leaving nearby geometry untouched.

An exclude region does the opposite: it marks an area that the toolpath should avoid. You might use one to preserve a logo area during surfacing, leave material around a fixture feature, or prevent a broad clearing operation from entering a delicate section of a part.

The region affects an operation when you include it in that operation's target selection. It is not a global keep-out zone and it does not automatically protect clamps or fixtures. Treat actual workholding clearance as a separate safety concern.

In CAM terms, regions are powerful because they separate what exists in the model from where a particular cutter is allowed to travel. You can keep one clean model while creating different machining boundaries for roughing, finishing, engraving, or cleanup passes.

## Construction Mode

Construction mode is for geometry that helps you design, but must never become part of the manufactured result.

Select Construction mode, choose a line or shape, and draw a centerline through the panel. You could also draw a circle representing a bolt pattern, an offset rectangle for layout, or a spline to guide the placement of other geometry.

Construction geometry is visible on the sketch canvas and can be used as a reference for snapping and dimensions. It is there to make the design more precise and easier to edit.

But it is intentionally excluded from the solid model, toolpath generation, simulation, and export. A construction circle will not drill a hole. A construction rectangle will not become a pocket. A construction line will not engrave into the stock.

That makes Construction mode ideal for centerlines, symmetry references, temporary layout geometry, spacing guides, and design intent that should remain visible without affecting machining.

The practical habit is simple: if you would be alarmed to see the cutter follow it, draw it in Construction mode.

## Wrap-Up

The shape tool answers, “What geometry am I drawing?”

The drawing mode answers, “What job does that geometry perform?”

Features create the solid model and define material or removed material. Lines create machinable paths without volume. Regions control where CAM operations may or may not cut. Construction geometry supports design and measurement, but is deliberately invisible to manufacturing.

Define the stock first, choose the drawing mode second, and then choose the shape. That order keeps the model easier to reason about, gives new features sensible default Z values, and makes the resulting toolpaths much more predictable.
