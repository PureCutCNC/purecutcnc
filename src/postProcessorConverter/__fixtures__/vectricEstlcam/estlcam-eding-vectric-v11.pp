+================================================
+                                                
+ Estlcam - Vectric machine output configuration file   
+                                                
+================================================
+                                                
+ History                                        
+                                                
+ Who      When       Ver  What                      
+ ======== ========== ===  ======= 
+ Tommy	   2017-08-25      Anpassung an Estlcam
+ RK       2007-12-05 V1.0 K�hlmittelausgang implementiert
+                          Dokumentation stark ausgebaut
+ bloodyt  2021-07-30	   Feedratemultiplier f�r FEED_RATE/CUT_RATE/PLUNGE_RATE auf 1 f�r mm/min
+ miniwini 2021-09-07      Werkzeugwechsel mit Werkzeugangabe, Code von unn�tigen Zeilenangaben befreit
+ miniwini 2021-09-09      Fr�svorgang startet mit Werkzeugwechsel, zur erinnerung das auch der richtige Fr�ser drin ist...
+ jetco_cnc 2024-07-28     Added outputs for helical moves and toolpath segment headers, changed footer to raise Z to MCS 0 when finished
+  
+  
+            
+================================================

POST_NAME = "Estlcam_Eding V11(*.nc)"

FILE_EXTENSION = "nc"

UNITS = "MM"

+------------------------------------------------
+    Line terminating characters                 
+------------------------------------------------

LINE_ENDING = "[13][10]"

+------------------------------------------------
+    Block numbering                             
+------------------------------------------------

LINE_NUMBER_START     = 0
LINE_NUMBER_INCREMENT = 1
LINE_NUMBER_MAXIMUM = 999999

+================================================
+                                                
+    Formating for variables                     
+                                                
+================================================

VAR LINE_NUMBER = [N|A|N|1.0]
VAR SPINDLE_SPEED = [S|A|S|1.0]
VAR FEED_RATE = [F|C|F|1.1|1]
VAR CUT_RATE    = [FC|A||1.0|1]
VAR PLUNGE_RATE = [FP|A||1.0|1]
VAR X_POSITION = [X|C|X|1.3]
VAR Y_POSITION = [Y|C|Y|1.3]
VAR Z_POSITION = [Z|C|Z|1.3]
VAR ARC_CENTRE_I_INC_POSITION = [I|A|I|1.3]
VAR ARC_CENTRE_J_INC_POSITION = [J|A|J|1.3]
VAR X_HOME_POSITION = [XH|A|X|1.3]
VAR Y_HOME_POSITION = [YH|A|Y|1.3]
VAR Z_HOME_POSITION = [ZH|A|Z|1.3]

+================================================
+                                                
+    Block definitions for toolpath output       
+                                                
+================================================

+---------------------------------------------------
+  Commands output at the start of the file
+---------------------------------------------------

begin HEADER
"(---------------------------------------------------------------)"
"( Dateiinfo:                                                     )"
"(---------------------------------------------------------------)"
"( Dateiname: [TP_FILENAME])"
"( Dateiverzeichniss = [PATHNAME])"
"(---------------------------------------------------------------)"
"( Materialinfo:     Alle Groessen in mm                          )"
"(---------------------------------------------------------------)"
"(  X Laenge = [XLENGTH])"
"(  Y Laenge = [YLENGTH])"
"(  Z Laenge = [ZLENGTH])"
"(  X Min = [XMIN]   Y Min = [YMIN]  Z Min = [ZMIN])"
"(  X Max = [XMAX]   Y Max = [YMAX]  Z Max = [ZMAX])"
"()"
"( Parkpos: X = [XH] Y = [YH] Z = [ZH])" 
"( Sicherheitshoehe: Z = [SAFEZ])" 
"()"
"(---------------------------------------------------------------)"
"( Programm Start                                                )"
"(---------------------------------------------------------------)"
"%"
"(---------------------------------------------------------------)"
"( Erstes Werkzeug                                               )"
"(---------------------------------------------------------------)"
"(  Werkzeugnummer = [T])"
"(  Werkzeugname   = [TOOLNAME])"
"(  Vorschuebe                                                   )"
"(  Fraesvorschub  = [FC] mm/min)"
"(  Einstechen     = [FP] mm/min)"
"(  Drehzahl       = [S] U/min)"
"(---------------------------------------------------------------)"
"M05"
"G00 [ZH]"
" Msg[34] Fuer die Fraesbahn:[TOOLPATH_NAME] Bitte Werkzeug T[T] [TOOLNAME] einspannen [34] "
" T[T] M06"
"M03 [S]"
"(---------------------------------------------------------------)"
"( Konturname = [TOOLPATH_NAME])"
"(---------------------------------------------------------------)"


+---------------------------------------------------
+  Commands output for rapid moves 
+---------------------------------------------------

begin RAPID_MOVE

"G00 [X] [Y] [Z]"


+---------------------------------------------------
+  Commands output for the first feed rate move
+---------------------------------------------------

begin FIRST_FEED_MOVE

"G01 [X] [Y] [Z] [F]"


+---------------------------------------------------
+  Commands output for feed rate moves
+---------------------------------------------------

begin FEED_MOVE

"G01 [X] [Y] [Z]"

+---------------------------------------------------
+  Commands output for the first clockwise arc move
+---------------------------------------------------

begin FIRST_CW_ARC_MOVE

"G02 [X] [Y] [I] [J] [F]"

+---------------------------------------------------
+  Commands output for clockwise arc  move
+---------------------------------------------------

begin CW_ARC_MOVE

"G02 [X] [Y] [I] [J]"

+---------------------------------------------------
+  Commands output for the first counterclockwise arc move
+---------------------------------------------------

begin FIRST_CCW_ARC_MOVE

"G03 [X] [Y] [I] [J] [F]"

+---------------------------------------------------
+  Commands output for counterclockwise arc  move
+---------------------------------------------------

begin CCW_ARC_MOVE

"G03 [X] [Y] [I] [J]"

+---------------------------------------------------
+  Commands output for the first clockwise helical arc move
+---------------------------------------------------------
begin FIRST_CW_HELICAL_ARC_MOVE

"G02 [X] [Y] [I] [J] [Z] [F]"

+---------------------------------------------------------
+  Commands output for clockwise helical arc move
+---------------------------------------------------------
begin CW_HELICAL_ARC_MOVE

"G02 [X] [Y] [I] [J] [Z]"

+---------------------------------------------------------------
+  Commands output for the first counter-clockwise helical arc move
+---------------------------------------------------------------
begin FIRST_CCW_HELICAL_ARC_MOVE

"G03 [X] [Y] [I] [J] [Z] [F]"

+---------------------------------------------------------------
+  Commands output for counter-clockwise helical arc move
+---------------------------------------------------------------
begin CCW_HELICAL_ARC_MOVE

"G03 [X] [Y] [I] [J] [Z]"

+--------------------------------------------------------------------
+  Commands output for the first clockwise helical arc plunge move
+--------------------------------------------------------------------
begin FIRST_CW_HELICAL_ARC_PLUNGE_MOVE

"G02 [X] [Y] [I] [J] [Z] [F]"

+--------------------------------------------------------------------
+  Commands output for clockwise helical arc plunge move
+--------------------------------------------------------------------
begin CW_HELICAL_ARC_PLUNGE_MOVE

"G02 [X] [Y] [I] [J] [Z]"

+--------------------------------------------------------------------------
+  Commands output for the first counter-clockwise helical arc plunge move
+--------------------------------------------------------------------------
begin FIRST_CCW_HELICAL_ARC_PLUNGE_MOVE

"G03 [X] [Y] [I] [J] [Z] [F]"

+--------------------------------------------------------------------------
+  Commands output for counter-clockwise helical arc plunge move
+--------------------------------------------------------------------------
begin CCW_HELICAL_ARC_PLUNGE_MOVE

"G03 [X] [Y] [I] [J] [Z]"

+----------------------------------------------------------
+  Output for new segment - Toolpath with same tool and different spindle speed
+---------------------------------------------------

begin NEW_SEGMENT

" ( Spindle Speed: [S] )"
" [S] M03"
" Msg[34] T[T]: [TOOLNAME] [34] "
" Msg[34] Toolpath: [TOOLPATH_NAME] [34] "

+----------------------------------------------------
+  Output for all dwell times
+----------------------------------------------------

begin DWELL_MOVE

"G04 [DWELL]"

+---------------------------------------------------
+  Commands output at toolchange
+---------------------------------------------------
begin TOOLCHANGE
"(--------------------------------------------------------------)"
"( Werkzeugwechsel                                              )"
"(--------------------------------------------------------------)"
"(  Werkzeugnummer = [T])"
"(  Werkzeugname   = [TOOLNAME])"
"(  Vorige Werkzeugnummer = [TP])"
"()"
"(  Fraesvorschub  = [FC] mm/min)"
"(  Einstechen     = [FP] mm/min)"
"(  Drehzahl       = [S] U/min)"
"(---------------------------------------------------------------)"
"M05"
"G00 [ZH]"
" Msg[34] Fuer die Fraesbahn:[TOOLPATH_NAME] Bitte Werkzeug T[T] [TOOLNAME] einspannen [34] "
" T[T] M06"
"M03 [S]"
"(---------------------------------------------------------------)"
"( Konturname: [TOOLPATH_NAME])"
"(---------------------------------------------------------------)"
+---------------------------------------------------
+  Commands output at the end of the file
+---------------------------------------------------

begin FOOTER
" Msg[34] Programm Ende [34] "
" G53 G0 z0 (Raise Z MCS0)"
"G00 X0.0000 Y0.0000"
"M05"
"M09"
"M30"
