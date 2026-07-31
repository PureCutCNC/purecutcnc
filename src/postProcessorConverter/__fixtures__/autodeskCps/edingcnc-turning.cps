/**
  Copyright (C) 2007-2017 by HSMWorks ApS
  All rights reserved.

  Eding CNC turning post processor configuration.
  version 0.1 Beta
  Forked from 3114_Fanuc Doosan in computer.cps
  Arjan Grootenboer
  a.j.grootenboer@gmail.com 
  
  Please notice: 
  I have a 8 position turret on the Y axis, some mods made 
  to G28 to disable unwanted turret movement


*/

description = "Generic EdingCNC Turning";
vendor = "Grootenboer";
vendorUrl = "http://www.hsmworks.com";
legal = "Copyright (C) 2007-2017 HSMWorks ApS";
certificationLevel = 2;
minimumRevision = 24000;

extension = "nc";
programNameIsInteger = true;
setCodePage("ascii");

capabilities = CAPABILITY_TURNING;
tolerance = spatial(0.002, MM);

minimumChordLength = spatial(0.01, MM);
minimumCircularRadius = spatial(0.01, MM);
maximumCircularRadius = spatial(1000, MM);
minimumCircularSweep = toRad(0.01);
maximumCircularSweep = toRad(180);
allowHelicalMoves = true;
allowedCircularPlanes = undefined; // allow any circular motion



// user-defined properties
properties = {
  writeMachine: false, // write machine
  preloadTool: false, // preloads next tool on tool change if any
  showSequenceNumbers: false, // show sequence numbers
  sequenceNumberStart: 10, // first sequence number
  sequenceNumberIncrement: 5, // increment for sequence numbers
  optionalStop: true, // optional stop
  o8: false, // specifies 8-digit program number
  separateWordsWithSpace: true, // specifies that the words should be separated with a white space
  useRadius: true, // specifies that arcs should be output using the radius (R word) instead of the I, J, and K words.
  maximumSpindleSpeed: 100 * 60, // speciifes the maximum spindle speed
  type: "A", // specifies the type A, B, C
  showNotes: false, // specifies that operation notes should be output.
  KoelingBril: false,
  wisselPositie: 100,
  wisselPositieStatus: true,
  g76NumSpringPassDesire : 1, //specifies the number of spring pass desire
  g76finishingPassDepthDesire: 0.002
};



var permittedCommentChars = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,=_-#";

var mapCoolantTable = new Table(
  [9, 8, null, 88],
  {initial:COOLANT_OFF, force:true},
  "Invalid coolant mode"
);

var gFormat = createFormat({prefix:"G", decimals:1});
var mFormat = createFormat({prefix:"M", decimals:1});
var hFormat = createFormat({prefix:"H", decimals:1});
var dFormat = createFormat({prefix:"D", decimals:1});
var pFormat = createFormat({decimals:1});

var xFormat = createFormat({decimals:(unit == MM ? 6 : 7), forceDecimal:true, scale:2}); // diameter mode
var yFormat = createFormat({decimals:(unit == MM ? 6 : 7), forceDecimal:true});
var zFormat = createFormat({decimals:(unit == MM ? 6 : 7), forceDecimal:true});
var rFormat = createFormat({decimals:(unit == MM ? 6 : 7), forceDecimal:true}); // radius
var qFormat = createFormat({forceDecimal:false});
var feedFormat = createFormat({decimals:(unit == MM ? 4 : 5), forceDecimal:true});
var toolFormat = createFormat({decimals:0, width:2, zeropad:true});
var rpmFormat = createFormat({decimals:4});
var secFormat = createFormat({decimals:3, forceDecimal:true}); // seconds - range 0.001-99999.999
var milliFormat = createFormat({decimals:0}); // milliseconds // range 1-9999
var taperFormat = createFormat({decimals:1, scale:DEG});

var xOutput = createVariable({prefix:"X"}, xFormat);
var yOutput = createVariable({prefix:"Y"}, yFormat);
var zOutput = createVariable({prefix:"Z"}, zFormat);
var qOutput = createVariable({prefix:"Q"}, qFormat);
var feedOutput = createVariable({prefix:"F"}, feedFormat);
var sOutput = createVariable({prefix:"S", force:true}, rpmFormat);
var pOutput = createVariable({prefix:"P"}, pFormat);

// circular output
var kOutput = createReferenceVariable({prefix:"K"}, xFormat);
var iOutput = createReferenceVariable({prefix:"I"}, xFormat); // no scaling

var g92ROutput = createVariable({prefix:"R"}, zFormat); // no scaling

var gMotionModal = createModal({}, gFormat); // modal group 1 // G0-G3, ...
var gPlaneModal = createModal({onchange:function () {gMotionModal.reset();}}, gFormat); // modal group 2 // G17-19
var gAbsIncModal = createModal({}, gFormat); // modal group 3 // G90-91 // only for B and C mode
var gFeedModeModal = createModal({}, gFormat); // modal group 5 // G98-99 / G94-95
var gSpindleModeModal = createModal({}, gFormat); // modal group 5 // G96-97
var gUnitModal = createModal({}, gFormat); // modal group 6 // G20-21
var gCycleModal = createModal({}, gFormat); // modal group 9 // G81, ...
var gRetractModal = createModal({}, gFormat); // modal group 10 // G98-99

var WARNING_WORK_OFFSET = 0;

var brilOpen = true;

// collected state
var sequenceNumber;
var currentWorkOffset;

/**
  Writes the specified block.
*/
function writeBlock() {
  if (properties.showSequenceNumbers) {
    writeWords2("N" + sequenceNumber, arguments);
    sequenceNumber += properties.sequenceNumberIncrement;
  } else {
    writeWords(arguments);
  }
}

/**
  Output a comment ,start with an ; in eding format.
*/
function writeComment(text) {
  writeln(";(" + filterText(String(text).toUpperCase(), permittedCommentChars) + ")");
}

function onOpen() {

  if (!(properties.type in {"A":0, "B":0, "C":0})) {
    error(localize("Unsupported type. Only A, B, and C are allowed."));
    return;
  }
  
  yOutput.disable();

  if (!properties.separateWordsWithSpace) {
    setWordSeparator("");
  }

  sequenceNumber = properties.sequenceNumberStart;
  writeln("%");

  if (programName) {
    var programId;
    try {
      programId = getAsInt(programName);
    } catch(e) {
      error(localize("Program name must be a number."));
    }
    if (properties.o8) {
      if (!((programId >= 1) && (programId <= 99999999))) {
        error(localize("Program number is out of range."));
      }
    } else {
      if (!((programId >= 1) && (programId <= 9999))) {
        error(localize("Program number is out of range."));
      }
    }
    if ((programId >= 8000) && (programId <= 9999)) {
      warning(localize("Program number is reserved by tool builder."));
    }
    var oFormat = createFormat({width:(properties.o8 ? 8 : 4), zeropad:true, decimals:0});
    if (programComment) {
      writeln(";" + oFormat.format(programId) + " (" + filterText(String(programComment).toUpperCase(), permittedCommentChars) + ")");
    } else {
      writeln(";" + oFormat.format(programId));
    }
  } else {
    error(localize("Program name has not been specified."));
  }

  // dump machine configuration
  var vendor = machineConfiguration.getVendor();
  var model = machineConfiguration.getModel();
  var description = machineConfiguration.getDescription();

  if (properties.writeMachine && (vendor || model || description)) {
    writeComment(localize("Machine"));
    if (vendor) {
      writeComment("  " + localize("vendor") + ": " + vendor);
    }
    if (model) {
      writeComment("  " + localize("model") + ": " + model);
    }
    if (description) {
      writeComment("  " + localize("description") + ": "  + description);
    }
  }

  var turningProgram = (getNumberOfSections() > 0) && (getSection(0).getType() == TYPE_TURNING);

  // absolute coordinates and feed per min
  if (turningProgram) {
    if (properties.type == "A") {
      writeBlock(gFeedModeModal.format(98), gPlaneModal.format(18));
    } else {
      writeBlock(gAbsIncModal.format(90), gFeedModeModal.format(95), gPlaneModal.format(18));
    }
  }

  switch (unit) {
  case IN:
    writeBlock(gUnitModal.format(20));
    break;
  case MM:
    writeBlock(gUnitModal.format(21));
    break;
  }

  if (turningProgram) {
    if (properties.type == "A") {
      writeBlock(
        gFormat.format(50), sOutput.format(properties.maximumSpindleSpeed)
      );
    } else {
      writeBlock(
        gFormat.format(92), sOutput.format(properties.maximumSpindleSpeed)
      );
    }
  }
}

function onComment(message) {
  writeComment(message);
}


/** Force output of X, Y, and Z. */
function forceXYZ() {
  xOutput.reset();
  yOutput.reset();
  zOutput.reset();
}

/** Force output of X, Y, Z, and F on next output. */
function forceAny() {
  forceXYZ();
  feedOutput.reset();
}

function onSection() {


  var insertToolCall = isFirstSection() ||
    currentSection.getForceToolChange && currentSection.getForceToolChange() ||
    (tool.number != getPreviousSection().getTool().number);
  var retracted = false; // specifies that the tool has been retracted to the safe plane

  if (insertToolCall) {      
    // retract to safe plane
    retracted = true;
    //changed Arjan
    //writeBlock(gFormat.format(28), "U" + xFormat.format(0)); // retract

    writeBlock(gFormat.format(00), "X#5161", "Z#5163");   // this was a G28, and that doesn't work with a turret on the Y axis.


  if(properties.wisselPositieStatus){
    writeBlock(gFormat.format(00), "Z" + zFormat.format(properties.wisselPositie));}
    forceXYZ();
  }
  if(properties.KoelingBril & brilOpen == true){
  	writeBlock(mFormat.format(58));
	brilOpen = false;
	}

  
  if (hasParameter("operation-comment")) {
    var comment = getParameter("operation-comment");
    if (comment) {
      writeComment(comment);
    }
  }

  if (properties.showNotes && hasParameter("notes")) {
    var notes = getParameter("notes");
    if (notes) {
      var lines = String(notes).split("\n");
      var r1 = new RegExp("^[\\s]+", "g");
      var r2 = new RegExp("[\\s]+$", "g");
      for (line in lines) {
        var comment = lines[line].replace(r1, "").replace(r2, "");
        if (comment) {
          writeComment(comment);
        }
      }
    }
  }

  if (insertToolCall) {
    retracted = true;
    onCommand(COMMAND_COOLANT_OFF);
  
    if (!isFirstSection() && properties.optionalStop) {
      onCommand(COMMAND_OPTIONAL_STOP);
    }
    // using an 8 position automatic turret
    if (tool.number > 8) {
      warning(localize("Tool number exceeds maximum value."));
    }

    var compensationOffset = tool.isTurningTool() ? tool.compensationOffset : tool.lengthOffset;
    if (compensationOffset > 99) {
      error(localize("Compensation offset is out of range."));
      return;
    }
    // changed Arjan
    // writeBlock("T" + toolFormat.format(tool.number * 100 + compensationOffset));
    writeBlock("M6", "T" + toolFormat.format(tool.number));  

    if (tool.comment) {
      writeComment(tool.comment);
    }

    if (properties.preloadTool) {
      var nextTool = getNextTool(tool.number);
      if (nextTool) {
        var compensationOffset = nextTool.isTurningTool() ? nextTool.compensationOffset : nextTool.lengthOffset;
        if (compensationOffset > 99) {
          error(localize("Compensation offset is out of range."));
          return;
        }
        //writeBlock("T" + toolFormat.format(nextTool.number * 100 + compensationOffset));
        writeBlock("M6" + "T" + toolFormat.format(tool.number));
      } else {
        // preload first tool
        var section = getSection(0);
        var firstTool = section.getTool().number;
        if (tool.number != firstTool.number) {
          var compensationOffset = firstTool.isTurningTool() ? firstTool.compensationOffset : firstTool.lengthOffset;
          if (compensationOffset > 99) {
            error(localize("Compensation offset is out of range."));
            return;
          }
          //writeBlock("T" + toolFormat.format(firstTool.number * 100 + compensationOffset));
          writeBlock("M6", "T" + toolFormat.format(tool.number));
        }
      }
    }
  }

  // wcs
  var workOffset = currentSection.workOffset;
  if (workOffset == 0) {
    warningOnce(localize("Work offset has not been specified. Using G54 as WCS."), WARNING_WORK_OFFSET);
    workOffset = 1;
  }
  if (workOffset > 0) {
    if (workOffset > 6) {
      var p = workOffset - 6; // 1->...
      if (p > 300) {
        error(localize("Work offset out of range."));
      } else {
        if (workOffset != currentWorkOffset) {
          writeBlock(gFormat.format(54.1), "P" + p); // G54.1P
          currentWorkOffset = workOffset;
        }
      }
    } else {
      if (workOffset != currentWorkOffset) {
        writeBlock(gFormat.format(53 + workOffset)); // G54->G59
        currentWorkOffset = workOffset;
      }
    }
  }

  forceXYZ();

  // set coolant after we have positioned at Z
  {
    var c = mapCoolantTable.lookup(tool.coolant);
    if (c) {
      if(properties.KoelingBril){
  	writeBlock(mFormat.format(108));
	}
      writeBlock(mFormat.format(c));
    } else {
      warning(localize("Coolant not supported."));
    }
  }

  forceAny();
  gMotionModal.reset();

  gFeedModeModal.reset();
  if (currentSection.feedMode == FEED_PER_REVOLUTION) {
    writeBlock(gFeedModeModal.format((properties.type == "A") ? 99 : 94));
  } else {
    writeBlock(gFeedModeModal.format((properties.type == "A") ? 98 : 95));
  }

  // writeBlock(mFormat.format(currentSection.tailstock ? x : x));
  // writeBlock(mFormat.format(clampPrimaryChuck ? x : x));
  // writeBlock(mFormat.format(clampSecondaryChuck ? x : x));

  var mSpindle = tool.clockwise ? 3 : 4;
  var SpindleCode =  11;
  
  /*
  switch (currentSection.getSpindle()) {
  case SPINDLE_PRIMARY:
    mSpindle = tool.clockwise ? 3 : 4;
    break;
  case SPINDLE_SECONDARY:
    mSpindle = tool.clockwise ? 143 : 144;
    break;
  }
  */
  
  gSpindleModeModal.reset();
  if (currentSection.getTool().getSpindleMode() == SPINDLE_CONSTANT_SURFACE_SPEED) {
    writeBlock(gSpindleModeModal.format(96), sOutput.format(tool.surfaceSpeed * (1/1000)), mFormat.format(mSpindle), pOutput.format(SpindleCode));
	pOutput.reset();  
} else {
    
     //changed Arjan
     //writeBlock(gSpindleModeModal.format(97), sOutput.format(tool.spindleRPM), mFormat.format(mSpindle), pOutput.format(SpindleCode));
     writeBlock(gSpindleModeModal.format(97), sOutput.format(tool.spindleRPM));	

     pOutput.reset();
  }
  
  setRotation(currentSection.workPlane);

  var initialPosition = getFramePosition(currentSection.getInitialPosition());
  if (!retracted) {
    // TAG: need to retract along X or Z
    if (getCurrentPosition().z < initialPosition.z) {
      writeBlock(gMotionModal.format(0), zOutput.format(initialPosition.z));
    }
  }

  if (insertToolCall) {

    gMotionModal.reset();
    
    if (properties.type == "A") {
      writeBlock(
        gMotionModal.format(0), xOutput.format(initialPosition.x), yOutput.format(initialPosition.y), zOutput.format(initialPosition.z)
      );
    } else {
      writeBlock(
        gAbsIncModal.format(90),
        gMotionModal.format(0), xOutput.format(initialPosition.x), yOutput.format(initialPosition.y), zOutput.format(initialPosition.z)
      );
    }

    gMotionModal.reset();
  }
}

function onDwell(seconds) {
  if (seconds > 99999.999) {
    warning(localize("Dwelling time is out of range."));
  }
  milliseconds = clamp(1, seconds * 1000, 99999999);
  writeBlock(/*gFeedModeModal.format(94),*/ gFormat.format(4), "P" + milliFormat.format(milliseconds));
}

var pendingRadiusCompensation = -1;

function onRadiusCompensation() {
  pendingRadiusCompensation = radiusCompensation;
}

function onRapid(_x, _y, _z) {
  var x = xOutput.format(_x);
  var y = yOutput.format(_y);
  var z = zOutput.format(_z);
  if (x || y || z) {
    if (pendingRadiusCompensation >= 0) {
      pendingRadiusCompensation = -1;
      switch (radiusCompensation) {
      case RADIUS_COMPENSATION_LEFT:
        writeBlock(gMotionModal.format(0), x, y, z);
        break;
      case RADIUS_COMPENSATION_RIGHT:
        writeBlock(gMotionModal.format(0), x, y, z);
        break;
      default:
        writeBlock(gMotionModal.format(0), x, y, z);
      }
    } else {
      writeBlock(gMotionModal.format(0), x, y, z);
    }
    feedOutput.reset();
  }
}

function onLinear(_x, _y, _z, feed) {
  var x = xOutput.format(_x);
  var y = yOutput.format(_y);
  var z = zOutput.format(_z);
  var f = feedOutput.format(feed);
  if (x || y || z) {
    if (pendingRadiusCompensation >= 0) {
      pendingRadiusCompensation = -1;
      switch (radiusCompensation) {
      case RADIUS_COMPENSATION_LEFT:
        writeBlock(gMotionModal.format(1), x, y, z, f);
        break;
      case RADIUS_COMPENSATION_RIGHT:
        writeBlock(gMotionModal.format(1), x, y, z, f);
        break;
      default:
        writeBlock(gMotionModal.format(1), x, y, z, f);
      }
    } else {
      writeBlock(gMotionModal.format(1), x, y, z, f);
    }
  } else if (f) {
    if (getNextRecord().isMotion()) { // try not to output feed without motion
      feedOutput.reset(); // force feed on next line
    } else {
      writeBlock(gMotionModal.format(1), f);
    }
  }
}

function onCircular(clockwise, cx, cy, cz, x, y, z, feed) {
  if (pendingRadiusCompensation >= 0) {
    error(localize("Radius compensation cannot be activated/deactivated for a circular move."));
    return;
  }

  var start = getCurrentPosition();

  if (isFullCircle()) {
    if (properties.useRadius || isHelical()) { // radius mode does not support full arcs
      linearize(tolerance);
      return;
    }
    switch (getCircularPlane()) {
    case PLANE_XY:
      writeBlock(conditional(properties.type != "A", gAbsIncModal.format(90)), gPlaneModal.format(17), gMotionModal.format(clockwise ? 2 : 3), iOutput.format(cx - start.x, 0), jOutput.format(cy - start.y, 0), feedOutput.format(feed));
      break;
    case PLANE_ZX:
      writeBlock(conditional(properties.type != "A", gAbsIncModal.format(90)), gPlaneModal.format(18), gMotionModal.format(clockwise ? 2 : 3), iOutput.format(cx - start.x, 0), kOutput.format(cz - start.z, 0), feedOutput.format(feed));
      break;
    case PLANE_YZ:
      writeBlock(conditional(properties.type != "A", gAbsIncModal.format(90)), gPlaneModal.format(19), gMotionModal.format(clockwise ? 2 : 3), jOutput.format(cy - start.y, 0), kOutput.format(cz - start.z, 0), feedOutput.format(feed));
      break;
    default:
      linearize(tolerance);
    }
  } else if (!properties.useRadius) {
    switch (getCircularPlane()) {
    case PLANE_XY:
      writeBlock(conditional(properties.type != "A", gAbsIncModal.format(90)), gPlaneModal.format(17), gMotionModal.format(clockwise ? 2 : 3), xOutput.format(x), yOutput.format(y), zOutput.format(z), iOutput.format(cx - start.x, 0), jOutput.format(cy - start.y, 0), feedOutput.format(feed));
      break;
    case PLANE_ZX:
      writeBlock(conditional(properties.type != "A", gAbsIncModal.format(90)), gPlaneModal.format(18), gMotionModal.format(clockwise ? 2 : 3), xOutput.format(x), yOutput.format(y), zOutput.format(z), iOutput.format(cx - start.x, 0), kOutput.format(cz - start.z, 0), feedOutput.format(feed));
      break;
    case PLANE_YZ:
      writeBlock(conditional(properties.type != "A", gAbsIncModal.format(90)), gPlaneModal.format(19), gMotionModal.format(clockwise ? 2 : 3), xOutput.format(x), yOutput.format(y), zOutput.format(z), jOutput.format(cy - start.y, 0), kOutput.format(cz - start.z, 0), feedOutput.format(feed));
      break;
    default:
      linearize(tolerance);
    }
  } else { // use radius mode
    var r = getCircularRadius();
    if (toDeg(getCircularSweep()) > 180) {
      r = -r; // allow up to <360 deg arcs
    }
    switch (getCircularPlane()) {
    case PLANE_XY:
      writeBlock(gPlaneModal.format(17), gMotionModal.format(clockwise ? 2 : 3), xOutput.format(x), yOutput.format(y), zOutput.format(z), "R" + rFormat.format(r), feedOutput.format(feed));
      break;
    case PLANE_ZX:
      writeBlock(gPlaneModal.format(18), gMotionModal.format(clockwise ? 2 : 3), xOutput.format(x), yOutput.format(y), zOutput.format(z), "R" + rFormat.format(r), feedOutput.format(feed));
      break;
    case PLANE_YZ:
      writeBlock(gPlaneModal.format(19), gMotionModal.format(clockwise ? 2 : 3), xOutput.format(x), yOutput.format(y), zOutput.format(z), "R" + rFormat.format(r), feedOutput.format(feed));
      break;
    default:
      linearize(tolerance);
    }
  }
}

function onCycle() {
  writeBlock(gPlaneModal.format(18));
}

function getCommonCycle(x, y, z, r) {
  return [xOutput.format(x), yOutput.format(y),
    zOutput.format(z),
    "R" + zFormat.format(r)];
}

function onCyclePoint(x, y, z) {
   var useCycle = getParameter("operation:useCycle");
   if (isLastCyclePoint() && useCycle) {
   switch (cycleType) {
    case "thread-turning":
		var minDepthCut = Math.ceil(getParameter("operation:threadDepth")*1000/(getParameter("operation:numberOfStepdowns")));
		var numberOfStepdowns = milliFormat.format(getParameter("operation:numberOfStepdowns"));
		var threadDepth = secFormat.format(getParameter("operation:threadDepth"));
		var incrementalDepth = threadDepth/numberOfStepdowns;
		var cuttingFeedrate = feedOutput.format(getParameter("movement:cutting"));
                var calcIvalue = (x * 2); 	
		
	/* Pxxyyzz   xx- number of spring, yy- chamfer amount to pull, zz-thread angle*/
	/* mod Arjan removed the whole writeBlock(
        (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(76),
		"P0" + getParameter("operation:nullPass")*properties.g76NumSpringPassDesire+ "00" + getParameter("operation:infeedAngle"),
		"Q" + Math.ceil(getParameter("operation:threadDepth")*1000/(getParameter("operation:numberOfStepdowns"))),//  for 1st pass PITCH*0.6 =~ THREAD HEIGHT *0.3
          "R" + properties.g76finishingPassDepthDesire
		  );  */
    	
           gMotionModal.reset();
		  
 		xOutput.reset(); // at least one axis is required
		zOutput.reset();
		feedOutput.reset();
      writeBlock(
	  gFormat.format(76),
		"P" + threadDepth,
                zOutput.format(z),
                "I" + calcIvalue,
                "J" + incrementalDepth, 
                "K" + threadDepth 
		
		//"Q" + minDepthCut,
		//cuttingFeedrate
     );
	  
	 writeBlock(gCycleModal.format(80));
      break;
 }
 } else {

  switch (cycleType) {
  case "thread-turning":
    var r = -cycle.incrementalX; // positive if taper goes down - delta radius
    var threadsPerInch = ((unit == MM) ? 1.0 : 25.4)/cycle.pitch; // per mm for metric
    var f = 1/threadsPerInch;
    var codes = {A: 92, B: 78, C: 21};
    writeBlock(
      gMotionModal.format(codes[properties.type]),
      xOutput.format(x - cycle.incrementalX),
      yOutput.format(y),
      zOutput.format(z),
      feedOutput.format(f)
    );
    return;
  }
  }
  if (isFirstCyclePoint()) {
    repositionToCycleClearance(cycle, x, y, z);
    
    // return to initial Z which is clearance plane and set absolute mode

    var F = cycle.feedrate;
    var P = (cycle.dwell == 0) ? 0 : clamp(1, cycle.dwell * 1000, 99999999); // in milliseconds

    switch (cycleType) {
    case "drilling":
      writeBlock(
        (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(83),
        getCommonCycle(x, y, z, cycle.retract),
        feedOutput.format(F)
      );
      break;
    case "counter-boring":
      if (P > 0) {
        writeBlock(
          (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(82),
          getCommonCycle(x, y, z, cycle.retract),
          "P" + milliFormat.format(P),
          feedOutput.format(F)
        );
      } else {
        writeBlock(
          (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(83),
          getCommonCycle(x, y, z, cycle.retract),
          feedOutput.format(F)
        );
      }
      break;
    case "chip-breaking":
      // cycle.accumulatedDepth is ignored
      if (P > 0) {
        expandCyclePoint(x, y, z);
      } else {
        writeBlock(
          (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(74),
          getCommonCycle(x, y, z, cycle.retract),
          "Q" + qFormat.format(cycle.incrementalDepth*1000),
          feedOutput.format(F)
        );
      }
      break;
    case "deep-drilling":
      if (P > 0) {
        expandCyclePoint(x, y, z);
      } else {
        writeBlock(
          (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(83),
          getCommonCycle(x, y, z, cycle.retract),
          "Q" + qFormat.format(cycle.incrementalDepth*1000),
          // conditional(P > 0, "P" + milliFormat.format(P)),
          feedOutput.format(F)
        );
      }
      break;
    case "tapping":
      if (!F) {
        F = tool.getTappingFeedrate();
      }
      writeBlock(mFormat.format(29), sOutput.format(tool.spindleRPM));
      writeBlock(
        (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format((tool.type == TOOL_TAP_LEFT_HAND) ? 74 : 84),
        getCommonCycle(x, y, z, cycle.retract),
        "P" + milliFormat.format(P),
        feedOutput.format(F)
      );
      break;
    case "left-tapping":
      if (!F) {
        F = tool.getTappingFeedrate();
      }
      writeBlock(mFormat.format(29), sOutput.format(tool.spindleRPM));
      writeBlock(
        (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(74),
        getCommonCycle(x, y, z, cycle.retract),
        "P" + milliFormat.format(P),
        feedOutput.format(F)
      );
      break;
    case "right-tapping":
      if (!F) {
        F = tool.getTappingFeedrate();
      }
      writeBlock(mFormat.format(29), sOutput.format(tool.spindleRPM));
      writeBlock(
        (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(84),
        getCommonCycle(x, y, z, cycle.retract),
        "P" + milliFormat.format(P),
        feedOutput.format(F)
      );
      break;
    case "tapping-with-chip-breaking":
    case "left-tapping-with-chip-breaking":
    case "right-tapping-with-chip-breaking":
      if (!F) {
        F = tool.getTappingFeedrate();
      }
      writeBlock(mFormat.format(29), sOutput.format(tool.spindleRPM));
      writeBlock(
        (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format((tool.type == TOOL_TAP_LEFT_HAND ? 74 : 84)),
        getCommonCycle(x, y, z, cycle.retract),
        "P" + milliFormat.format(P),
        "Q" + xFormat.format(cycle.incrementalDepth),
        feedOutput.format(F)
      );
      break;
    case "fine-boring":
      writeBlock(
        (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(76),
        getCommonCycle(x, y, z, cycle.retract),
        "P" + milliFormat.format(P), // not optional
        "Q" + xFormat.format(cycle.shift),
        feedOutput.format(F)
      );
      break;
    case "reaming":
      if (P > 0) {
        writeBlock(
          (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(89),
          getCommonCycle(x, y, z, cycle.retract),
          "P" + milliFormat.format(P),
          feedOutput.format(F)
        );
      } else {
        writeBlock(
          (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(85),
          getCommonCycle(x, y, z, cycle.retract),
          feedOutput.format(F)
        );
      }
      break;
    case "stop-boring":
      if (P > 0) {
        expandCyclePoint(x, y, z);
      } else {
        writeBlock(
          (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(86),
          getCommonCycle(x, y, z, cycle.retract),
          feedOutput.format(F)
        );
      }
      break;
    case "boring":
      if (P > 0) {
        writeBlock(
          (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(89),
          getCommonCycle(x, y, z, cycle.retract),
          "P" + milliFormat.format(P), // not optional
          feedOutput.format(F)
        );
      } else {
        writeBlock(
          (properties.type == "A") ? "" : gRetractModal.format(98), conditional(properties.type != "A", gAbsIncModal.format(90)), gCycleModal.format(85),
          getCommonCycle(x, y, z, cycle.retract),
          feedOutput.format(F)
        );
      }
      break;
    default:
      expandCyclePoint(x, y, z);
    }
  } else {
    if (cycleExpanded) {
      expandCyclePoint(x, y, z);
    } else {
      writeBlock(yOutput.format(y));
    }
  }
}

function onCycleEnd() {
  if (!cycleExpanded) {
    switch (cycleType) {
    case "thread-turning":
      feedOutput.reset();
      xOutput.reset();
      zOutput.reset();
      pOutput.reset();
      g92ROutput.reset();
      break;
    default:
      writeBlock(gCycleModal.format(0), gCycleModal.format(80));
      zOutput.reset();
      xOutput.reset();
      pOutput.reset();
    }
  }
}

var mapCommand = {
  COMMAND_STOP:0,
  COMMAND_OPTIONAL_STOP:1,
  COMMAND_END:2,
  COMMAND_SPINDLE_CLOCKWISE:3,
  COMMAND_SPINDLE_COUNTERCLOCKWISE:4,
  COMMAND_STOP_SPINDLE:5,
  COMMAND_ORIENTATE_SPINDLE:19,
  COMMAND_LOAD_TOOL:6,
  COMMAND_COOLANT_ON:8,
  COMMAND_COOLANT_OFF:9,
  COMMAND_OPEN_DOOR:10,
  COMMAND_CLOSE_DOOR:11
};
function onParameter(name, value) {
if (name == "call-subprogram") {
writeBlock("M01");
writeBlock("M09");
if(properties.wisselPositieStatus){
    //writeBlock(gFormat.format(28), "U" + xFormat.format(0));
    //writeBlock(gFormat.format(28));
    writeBlock(gFormat.format(00), "X#5161", "Z#5163");   // this was a G28, doesn't work with a turret on Y.

    writeBlock(gFormat.format(00), "Z" + zFormat.format(properties.wisselPositie));}
writeBlock("M98", "P" + value);
}
  if (name == "action") {
    if (value == "opvangen") {
      writeBlock(mFormat.format(10));
    }
   if (value == "wegleggen") {
      writeBlock(mFormat.format(11));
    }
   if (value == "doorvoeren") {
if(properties.wisselPositieStatus){
    //writeBlock(gFormat.format(28));
    writeBlock(gFormat.format(00), "X#5161", "Z#5163");   // dit was een G28, dat kan niet met de turret op Y.

    writeBlock(gFormat.format(00), "Z" + zFormat.format(properties.wisselPositie));}
      writeBlock(mFormat.format(98), "P8999");
      writeBlock("/2", mFormat.format(98), "P8998");
    }
   if (value == "M99") {
      writeBlock(mFormat.format(54));
      writeBlock("/", mFormat.format(99));
    }
  }
}

function onCommand(command) {
  switch (command) {
  case COMMAND_START_SPINDLE:
    onCommand(tool.clockwise ? COMMAND_SPINDLE_CLOCKWISE : COMMAND_SPINDLE_COUNTERCLOCKWISE);
    return;
  case COMMAND_BREAK_CONTROL:
    return;
  case COMMAND_TOOL_MEASURE:
    return;
  }
  var stringId = getCommandStringId(command);
  var mcode = mapCommand[stringId];
  if (mcode != undefined) {
    writeBlock(mFormat.format(mcode));
  } else {
    onUnsupportedCommand(command);
  }

}

function onSectionEnd() {
  forceAny();
}

function onClose() {
  onCommand(COMMAND_COOLANT_OFF);

  // we might want to retract in Z before X
  // writeBlock(gFormat.format(28), "U" + xFormat.format(0)); // retract

  forceXYZ();
  if (!machineConfiguration.hasHomePositionX() && !machineConfiguration.hasHomePositionY()) {
    //writeBlock(gFormat.format(28), "U" + xFormat.format(0), conditional(yOutput.isEnabled(), "V" + yFormat.format(0))); // return to home
    //writeBlock(gFormat.format(28),conditional(yOutput.isEnabled(), "V" + yFormat.format(0))); // return to home
    writeBlock(gFormat.format(00), "X#5161", "Z#5163");   // dit was een G28, dat kan niet met de turret op Y.
    if(properties.wisselPositieStatus){
    writeBlock(gFormat.format(00), "Z" + zFormat.format(properties.wisselPositie));}
  } else {
    var homeX;
    if (machineConfiguration.hasHomePositionX()) {
      homeX = xOutput.format(machineConfiguration.getHomePositionX());
    }
    var homeY;
    if (yOutput.isEnabled() && machineConfiguration.hasHomePositionY()) {
      homeY = yOutput.format(machineConfiguration.getHomePositionY());
    }
    if (properties.type == "A") {
      writeBlock(gFormat.format(53), gMotionModal.format(0), homeX, homeY, zOutput.format(machineConfiguration.getRetractPosition()));
    } else {
      writeBlock(gAbsIncModal.format(90), gFormat.format(53), gMotionModal.format(0), homeX, homeY, zOutput.format(machineConfiguration.getRetractPosition()));
    }
  }

  onImpliedCommand(COMMAND_END);
  onImpliedCommand(COMMAND_STOP_SPINDLE);
  writeBlock(mFormat.format(30)); // stop program, spindle stop, coolant off
  writeln("%");
}
