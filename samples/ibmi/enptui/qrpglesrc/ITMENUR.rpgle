**free
ctl-opt dftactgrp(*no) actgrp(*caller) option(*srcstmt:*nodebugio);

dcl-f ITMENUD workstn;

RESULT = 'No selection yet';

dou *in03;
    write PFILE;
    write PVIEW;
    exfmt MAIN;

    if MNUCHC = 1 and PULLCHC > 0;
        RESULT = 'File choice ' + %trim(%char(PULLCHC));
    elseif MNUCHC = 2 and PULLCHC > 0;
        RESULT = 'View choice ' + %trim(%char(PULLCHC));
    elseif *in12;
        RESULT = 'Pulldown cancelled with CA12';
        *in12 = *off;
    endif;
enddo;

*inlr = *on;
return;
