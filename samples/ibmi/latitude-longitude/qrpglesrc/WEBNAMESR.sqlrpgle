       //  _____________________________________________________________________
       //   ___             _    _     __ __             _    _
       //  | . > ___  ___ _| |_ | |_  |  \  \ ___  _ _ _| |_ <_>._ _
       //  | . \/ . \/ . \ | |  | . | |     |<_> || '_> | |  | || ' |
       //  |___/\___/\___/ |_|  |_|_| |_|_|_|<___||_|   |_|  |_||_|_|
       //
       //    Mar, 2020                                   booth@martinvt.com
       //  _____________________________________________________________________
       //   COMMENTS:   - Display the address file.
       //               - Format addresses to meet USPS guidelines.
       //               - Retrieve latitude and longitude from a web service.
       //               - Display a Google map of the location in a browser.
       //  _____________________________________________________________________
       ctl-opt option(*nodebugio) dftactgrp(*no) actgrp(*new);

       dcl-f WEBNAMESD workstn sfile(sfl1: sf1rrna);

       dcl-c cURLlat
         'https://geocoding.geo.census.gov/geocoder/locations/address?';
       dcl-c cURLtail '&benchmark=Public_AR_Current&format=json';
       dcl-c cURLmap 'https://www.google.com/maps/place/';
       dcl-s URL varchar(400);

       dcl-c cTrq x'30';
       dcl-c cRedu x'2C';
       dcl-c cWht x'22';

       dcl-c from 'abcdefghijklmnopqrstuvwxyz!@#$%';
       dcl-c to   'ABCDEFGHIJKLMNOPQRSTUVWXYZ+++++';

       dcl-ds wRecordDS extname('NAMEDATAP') end-ds;
       dcl-ds W2FieldsDS extname('NAMEDATAP') prefix('W2': 2) end-ds;

       dcl-s wLat packed(9: 6);
       dcl-s wLong packed(9: 6);

       dcl-ds USPSAddress;
         USPSStreet char(30);
         USPSCity char(30);
         USPSState char(2);
         USPSZIP char(10);
       end-ds;

       dcl-s wAddress1 like(W2ADDRESS1);
       dcl-s wAddress2 like(W2ADDRESS2);
       dcl-ds sResponse;
         wResponse char(33) dim(12);
       end-ds;
       dcl-s wCount packed(5);

       dcl-ds *n PSDS;
         USERID char(10) pos(358);
       end-ds;

       dcl-pr Qcmd extpgm('QCMDEXC');
         *n char(1024) const;
         *n packed(15: 5) const;
       end-pr;
       dcl-s wCmd varchar(1024);

      /free
       //  ____________________________________  Mainline  _____________________
       // The immediately following /EXEC SQL is SQL's version of RPG's H Spec.
       // It is never executed; it is used only at compile time.
       exec sql set option Commit = *Chg,
                           DatFmt = *ISO;
       exec sql declare C1 cursor for
         select * from NAMEDATAP
                  order by NANAME;
       exsr getHeading;
       exsr fillSfl;
       write FMT01;
       //  ____________________________________  Work Cycle  ___________________
       dou *inkc;
         write WIN02;
         exfmt WIN01;
         select;
         when *in03;                   // done.
         when SF1SLCTD > 0;            // Name selected
           chain SF1SLCTD SFL1;
           W2FieldsDS = S1RECORD;
         when *in09;                   // get and show latitude/longitude
           exsr getLatLong;
         when *in21;                   // show Google map
           exsr showMap;
         endsl;
       enddo;
       *inlr = *on;
       //  ___________________________________  End of Mainline  _______________
       //  ___________________________________  Fill window 1, subfile  ________
       begsr fillSfl;
         clear w2FieldsDS;
         W2TITLE = 'Details';
         // Clear subfile.
         *in90 = *off;
         write WIN01;
         *in90 = *on;
         SF1RRNA = 0;
         // Fill the subfile:
         exec sql open C1;
         dow Sqlcode = 0;                    // Table read loop
           exec sql fetch C1 into :wRecordDS;
           if sqlcode = 0;
             SF1RRNA = SF1RRNA + 1;
             S1NAME = NANAME;
             S1RECORD = wRecordDS;
             write SFL1;
           endif;
         enddo;
         exec sql close C1;
         // If no records found:
         if SF1RRNA = 0;
           SF1RRNA = 1;
           S1NAME = 'No Records.';
           write SFL1;
         endif;
         // Set subfile size:
         NBRRECS = SF1RRNA;
         SF1TOP = 1;
       endsr;
       //  ____________________________________  Get Lat and Long Process  _____
       begsr getLatLong;
         exsr getUSPSAddress;
         wCount = 5;
         exsr Trial1;
         if sqlcode <> 0;
           wCount += 1;
           wResponse(wCount) =
             '    Trial 1 failed: SQL code ' + %char(SQLcode);
           exsr Trial2;
         else;
           wCount += 1;
           wResponse(wCount) = '    Trial 1 succeeded.';
           W3RESPONSE = sResponse;
           exfmt WIN03;
           leavesr;
         endif;
         if sqlcode <> 0;
           wCount += 1;
           wResponse(wCount) =
             '    Trial 2 failed: SQL code ' + %char(SQLcode);
           exsr Trial3;
         else;
           wCount += 1;
           wResponse(wCount) = '    Trial 2 succeeded.';
           W3RESPONSE = sResponse;
           exfmt WIN03;
           leavesr;
         endif;
         if sqlcode <> 0;
           wCount += 1;
           wResponse(wCount) =
            '    Trial 3 failed: SQL code ' + %char(SQLcode);
         else;
           wCount += 1;
           wResponse(wCount) = '    Trial 3 succeeded.';
         endif;
         W3RESPONSE = sResponse;
         exfmt WIN03;
       endsr;
       //  ____________________________________  Try 1  ________________________
       begsr Trial1;
         URL = cURLlat
             + 'street=' + %trim(USPSStreet)
             + '&city=' + %trim(USPSCity)
             + '&state=' + %trim(USPSState)
             + '&zip=' + %trim(USPSZIP) + cURLtail;
         exsr getLatLongURL;
       endsr;
       //  ____________________________________  Try 2  ________________________
       begsr Trial2;
         URL = cURLlat
             + 'street=' + %trim(USPSStreet)
             + '&city='
             + '&state='
             + '&zip=' + %trim(USPSZIP) + cURLtail;
         exsr getLatLongURL;
       endsr;
       //  ____________________________________  Try 3  ________________________
       begsr Trial3;
         URL = cURLlat
             + '&street=' + %trim(USPSSTREET)
             + '&city='   + %trim(USPSCITY)
             + '&state='  + %trim(USPSSTATE)
             + '&zip=' + cURLtail;
         exsr getLatLongURL;
       endsr;
       //  ____________________________________  Get Lat and Long URL  _________
       begsr getLatLongURL;
         URL = %xlate(' ': '+': URL);
         exec sql select * into :wLat, :wLong
           from json_table(systools.httpgetclob(:URL, ''),
             'lax $.result.addressMatches[*]'
             columns(
               Latitude varchar(15) path '$.coordinates.y',
               Longitude varchar(15) path '$.coordinates.x')
               empty on error);
         wResponse(10) = 'Latitude is' + cWht + %char(wLat);
         wResponse(11) = 'Longitude is' + cWht + %char(wLong);
       endsr;
       //  ____________________________________  Format mailing address  _______
       begsr getUSPSAddress;
         clear wLat;
         clear wLong;
         clear wResponse;
         // Change to all upper case and replace certain characters:
         wAddress1 = %xlate(from: to: W2ADDRESS1);
         wAddress2 = %xlate(from: to: W2ADDRESS2);
         USPSCity = %xlate(from: to: W2CITY);
         USPSState = %xlate(from: to: W2STATE);
         USPSZIP = %xlate(from: to: W2ZIP);

         // Clear flaky street names.
         if wAddress1 <> *Blanks;
           if %subst(wAddress1: 1: 3) = 'N/A'
             or %scan('BOX': wAddress1) > *Zero
             or %scan('SUITE': wAddress1) > *Zero
             or %scan('DBA': wAddress1) > *Zero
             or %scan('ATTN': wAddress1) > *Zero
             or %scan('STORE': wAddress1) > *Zero
             or %scan('VENDOR ID': wAddress1) > *Zero
             or (%scan('0': wAddress1) = *Zero and
                 %scan('1': wAddress1) = *Zero and
                 %scan('2': wAddress1) = *Zero and
                 %scan('3': wAddress1) = *Zero and
                 %scan('4': wAddress1) = *Zero and
                 %scan('5': wAddress1) = *Zero and
                 %scan('6': wAddress1) = *Zero and
                 %scan('7': wAddress1) = *Zero and
                 %scan('8': wAddress1) = *Zero and
                 %scan('9': wAddress1) = *Zero);
             wAddress1 = *Blanks;
           endif;
         endif;
         if wAddress2 <> *Blanks;
           if %subst(wAddress2: 1: 3) = 'N/A'
             or %scan('BOX': wAddress2) > *Zero
             or %scan('SUITE': wAddress2) > *Zero
             or %scan('DBA': wAddress2) > *Zero
             or %scan('ATTN': wAddress2) > *Zero
             or %scan('STORE': wAddress2) > *Zero
             or %scan('VENDOR ID': wAddress2) > *Zero
             or (%scan('0': wAddress2) = *Zero and
                 %scan('1': wAddress2) = *Zero and
                 %scan('2': wAddress2) = *Zero and
                 %scan('3': wAddress2) = *Zero and
                 %scan('4': wAddress2) = *Zero and
                 %scan('5': wAddress2) = *Zero and
                 %scan('6': wAddress2) = *Zero and
                 %scan('7': wAddress2) = *Zero and
                 %scan('8': wAddress2) = *Zero and
                 %scan('9': wAddress2) = *Zero);
             wAddress2 = *Blanks;
           endif;
         endif;
         // Pick which street to use:
         select;
         when wAddress1 < '0' and wAddress2 > '0';
           USPSStreet = wAddress2;
         when wAddress1 = *Blanks;
           USPSStreet = wAddress2;
         when wAddress2 = *Blanks;
           USPSStreet = wAddress1;
         other;
           USPSStreet = wAddress1;
         endsl;
         // Fill first four lines of WIN03.
         wResponse(1) = cRedu + 'USPS Formatted Address:';
         wResponse(2) = '   ' + USPSStreet;
         wResponse(3) = '   ' + USPSCity;
         wResponse(4) = '   ' + USPSState + '  ' + USPSZIP;
         wResponse(5) = '  ' + cRedu;
       endsr;
       //  ___________________________________   Show Google map  ______________
       begsr showMap;
         exsr getUSPSAddress;
         wResponse(12) = 'Enter/click to show map.';
         W3RESPONSE = sResponse;
         exfmt WIN03;
         wCmd = 'STRPCO PCTA(*NO)';
         monitor;
           Qcmd(wCmd: %len(wCmd));
         on-error;
         endmon;
         URL = cURLmap
             + %trim(USPSStreet) + ','
             + %trim(USPSCity) + ','
             + %trim(USPSState) + '/';
         URL = %xlate(' ': '+': URL);
         wCmd = 'STRPCCMD PCCMD(''start ' + URL
              + ''') PAUSE(*NO)';
         Qcmd(wCmd: %len(wCmd));
       endsr;
       //  ____________________________________  Get Screen Heading  ___________
       begsr getHeading;
         HDG5X40 =
                   '   _      __    __                      '
                 + '  | | /| / /__ / /   -= Names Display =-'
                 + '  | |/ |/ / -_) _ \  -=  for demo of  =-'
                 + '  |__/|__/\__/_.__/  -=  Lat. & Long. =-';
         HDG7X23 =
                   '                       '
                 + '                       '
                 + '          ,,,          '
                 + '         (O-O)         '
                 + '  ----oo0-(_)-0oo----  '
                 + '                       '
                 + '                       ';
         exec SQL                    // Get user's name to display.
           select CID.ODOBTX
             into :S1USERNAME
             from Table(QSYS2/USERS()) AS CID
             where CID.ODOBNM = :USERID;
         if sqlcod <> 0 or %trim(S1USERNAME) = '';
           S1USERNAME = %trim(USERID);
         endif;
         evalr S1USERNAME = 'with' + cTrq + %trim(S1USERNAME);
       endsr;
      /end-free
